# AnoClaw 故障排查手册

> 面向用户、agent 和开发者。优先保护用户数据，不做破坏性操作。

## 总原则

1. 先看现象，再查日志。
2. 先做只读检查，再做修复。
3. 不删除 `data/`、`config/`、`plugins/<name>/data/`。
4. 构建前先杀掉 AnoClaw/Electron 残留进程。
5. 不运行 `npm run dev`；开发验证使用构建/打包流程。

## 双击 AnoClaw 没反应

常见原因：已有 AnoClaw/Electron 进程持有 single-instance lock。

检查：

```powershell
Get-Process -Name 'AnoClaw','electron' -ErrorAction SilentlyContinue
```

修复：

```powershell
Get-Process -Name 'AnoClaw' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
```

然后重新打开：

```text
D:/ANOCLAW/AnoClaw.exe
```

## 插件不加载

检查插件列表：

```bash
curl http://127.0.0.1:3456/api/v1/plugins
```

查看日志：

```bash
tail -80 logs/anochat.plugins.log
```

常见原因：

| 错误 | 原因 | 处理 |
|---|---|---|
| `Invalid JSON in plugin.json` | manifest JSON 格式错误 | 修正 JSON |
| `Missing "name"` | 缺少插件名 | 补 `name` |
| `Missing "main"` | 缺入口字段 | 补 `main` |
| `Entry file not found` | 入口路径错误 | 检查文件名 |
| `COMPILE_ERROR` | `.ts` 编译失败 | 看 esbuild 报错 |
| `IMPORT_ERROR` | import 失败 | 查依赖/路径 |
| `ACTIVATE_ERROR` | `onload()` 抛错或超时 | 缩短初始化、捕获错误 |
| `NO_ACTIVATE` | 函数式插件无 `activate`，类式插件不继承 `PluginBase` | 修入口导出 |

手动重载：

```bash
curl -X POST http://127.0.0.1:3456/api/v1/plugins/reload \
  -H "Content-Type: application/json" \
  -d '{"name":"my-plugin","action":"reload"}'
```

## 插件工具不出现

检查：

```bash
curl http://127.0.0.1:3456/api/v1/tools
curl http://127.0.0.1:3456/api/v1/plugins/my-plugin
```

排查：

- 是否在 `onload()` 中调用 `registerTool()`。
- 工具名是否和已有工具冲突。
- 插件是否处于 `activated` 状态。
- agent 的 `allowedTools` 是否允许该工具。
- 工具 description 是否足够清楚，agent 是否知道何时调用。

## 插件页面空白

检查顺序：

1. 打开 DevTools，切换到 iframe 上下文。
2. 看 console 是否有 JS 错误。
3. 检查 `frontend/index.html` 是否存在。
4. 检查相对路径：`bundle.js`、CSS 是否能 fetch。
5. 检查是否依赖未注入的全局变量。
6. 检查 `window.anoclaw.ui` 是否存在。

页面环境：

```text
sandbox="allow-scripts allow-forms allow-same-origin"
```

平台会注入 `tokens.css`、`plugin-raycast.css`、`anoclaw-ui.js`、`plugin-raycast.js`。

## API 路由无响应

检查：

```bash
curl http://127.0.0.1:3456/api/v1/plugins/my-plugin/status
```

排查：

- 是否调用了 `api.routes.register()` 或 `this.registerRoute()`。
- handler 名称是否和导出函数一致。
- handler 是否返回 `{ status, body }`。
- 路径是否和 manifest/API 调用一致。
- 插件是否 reload 后仍然 activated。

## agent 回答和实际行为不一致

处理：

1. 让 agent 读取相关 docs。
2. 让 agent 对照源码或运行结果验证。
3. 如果 docs 过旧，更新 `docs/`。
4. 如果是用户个人偏好，写 memory。
5. 如果是流程类问题，更新或创建 skill。

## 构建失败

建议顺序：

```powershell
Get-Process -Name 'AnoClaw','electron' -ErrorAction SilentlyContinue | Stop-Process -Force
```

然后按项目构建流程：

```bash
npx tsc --project tsconfig.json
node scripts/copy-monaco.js
node scripts/copy-vendor.js
cd src/public && npx tsc -p tsconfig.json && cd ../..
node scripts/bundle-css.js
node scripts/build-plugin-frontends.cjs
node scripts/build-icons.js
```

完整打包/热更新按仓库技能 `anoclaw-test-build` 执行。

不要用：

```bash
npm run dev
```

该命令依赖 Windows `cmd.exe` 启动脚本，在 Git Bash/WSL/PowerShell 中容易失败。

## WebSocket 或 UI 不刷新

检查：

- 浏览器是否连接 `ws://127.0.0.1:3456/ws?session=<id>`。
- `WsServer` 是否有 active connection。
- 相关事件是否进入 `TypedEventBus`。
- 插件 UI mount 是否广播了 `plugin:ui:mount`。
- 前端是否监听了对应消息类型。

## 数据保护

除非用户明确要求，不要删除：

- `data/sessions/`
- `data/agents/`
- `memory/`
- `config/`
- `plugins/<name>/data/`
- 用户 workspace 文件

可以安全清理的常见生成物：

- `dist/`
- `src/public/js/`
- `release*/`
- `plugins/<name>/.compile-cache/`

清理前先确认路径在 AnoClaw 项目目录内。
