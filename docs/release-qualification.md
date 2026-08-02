# Windows 发布验收

本文定义 AnoClaw Windows 安装包的最低发布门槛。它补充单元测试和 TypeScript 构建，验证用户实际拿到的 Electron 产物、首次启动、API 安全、插件连接及重启持久化。

## 产物契约

`package.json` 中的版本号是唯一版本来源。以 `2.0.1` 为例，`npm run package:win` 必须生成：

- `release9/AnoClaw.Setup.2.0.1.exe`：NSIS 安装程序；
- `release9/AnoClaw-2.0.1-win-unpacked.zip`：便携 ZIP；
- `release9/win-unpacked/AnoClaw.exe`：未压缩应用，仅用于本地验收；
- `release9/release-manifest.json` 与 `release9/SHA256SUMS.txt`：由产物检查生成。

`npm run release:verify` 会检查产物名称和最小大小，审计 `app.asar` 与解包目录，拒绝运行数据、配置、源码映射、内部维护文档及疑似真实凭据，并为两个可发布资产生成 SHA-256。

## 本地验收

正式构建必须先按仓库的 `anoclaw-packaging` 与 `anoclaw-test-build` 技能清理运行数据、终止残留进程并完成全量构建。不要使用 `npm run dev` 代替发布构建。

```powershell
npm test
npm run check:boundaries
npm run build:all
npm run package:win
npm run release:verify
npm run test:e2e:packaged
npm run release:verify
```

E2E 使用临时用户目录、临时工作区、随机本地端口及本地模拟 LLM；不会使用真实 API Key。它会通过 Electron 调试协议执行以下操作：

1. 完成首次启动向导并确认模拟 LLM 收到鉴权请求；
2. 等待主界面与全局 WebSocket 就绪；
3. 检查外部 API 未鉴权请求被拒绝、鉴权请求不泄露配置密钥；
4. 创建会话、绑定临时工作区并读写文件；
5. 打开 Gateway 与 MCP 插件页并确认其 WebSocket 已连接；
6. 退出并重启，确认不再进入向导，会话、工作区和插件连接仍正常。

截图、追踪与结果摘要写入 `.artifacts/release-qualification/`。测试结束只会清理临时目录以及受严格路径校验保护的 `release9/win-unpacked/resources/app.asar.unpacked` 运行数据。

## CI 与发布

`.github/workflows/release-qualification.yml` 在 Pull Request、`main` 推送和手动触发时运行完整 Windows 发布验收。CI 使用 NSIS 静默安装到临时目录，完成相同的真人操作流程，再静默卸载；失败时也会上传截图、Playwright trace、安装包、便携包与校验清单供排查。

NSIS 安装模式必须在没有 AnoClaw 安装记录的干净 Windows 主机上运行。安装器可能优先升级已登记的当前用户安装，即使命令行通过 `/D` 指定了临时目录；验收脚本会在启动安装器前检查卸载注册表项，发现现有安装时直接拒绝，避免覆盖开发机上的真实配置和数据。本地已有安装的机器应使用 `npm run test:e2e:packaged`，完整安装/卸载流程由干净的 CI 主机完成。

工作流只生成和保存候选产物，不自动创建 GitHub Release。发布者仍需确认：

- PR 已合并且必需检查全部成功；
- `release-manifest.json` 的提交与目标提交一致；
- GitHub Release 的版本号、标题和两个二进制资产一致；
- 发布说明记录验证结果、已知风险和回滚方式；
- 获得发布授权后再创建标签和 Release，禁止用 CI 绕过审批。
