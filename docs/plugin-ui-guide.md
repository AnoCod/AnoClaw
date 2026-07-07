# 插件 UI 与品牌设计指南

> 面向开发插件页面、工具面板和 UI 插槽的用户与 agent。

## 基本原则

AnoClaw 插件 UI 应像桌面工作台的一部分，而不是营销落地页：

- 优先信息密度、清晰层级和可重复操作。
- 使用 `tokens.css` 变量，自动适配深色/浅色主题。
- 不要在插件页里重新定义一整套无关设计系统。
- 不要用 emoji 当图标；需要图标时使用 SVG 或现有图标资源。
- 表单、列表、状态、错误、空状态都要有完整表现。
- 页面首屏应是可用工具界面，而不是介绍页。

## iframe 运行环境

插件页面通过 `PluginPageContainer` 渲染到 iframe：

```text
sandbox="allow-scripts allow-forms allow-same-origin"
```

平台自动注入：

- `css/tokens.css`
- `css/plugin-raycast.css`
- `anoclaw-ui.js`
- `plugin-raycast.js`
- `window.__ANOCLAW_PLUGIN_NAME__`

相对路径会被修正到插件目录，常规 `frontend/bundle.js`、`workflow-plugin.css` 这类引用可以正常加载。

## 主题同步

```javascript
function applyTheme(data) {
  if (data?.type !== 'anoclaw:theme') return;
  document.documentElement.setAttribute('data-theme', data.theme || 'dark');
  document.documentElement.setAttribute('data-accent', data.accent || 'white');
}

window.addEventListener('message', event => applyTheme(event.data));
```

CSS 使用变量：

```css
body {
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font: var(--font-body);
}

.panel {
  border: 1px solid var(--color-border-primary);
  background: var(--color-bg-secondary);
}
```

## 共享组件

`anoclaw-ui.js` 暴露：

| 类别 | 组件 |
|---|---|
| 基础 | `Button`, `Dialog`, `Toggle`, `Card`, `FormField`, `Input`, `Select`, `Textarea`, `Badge`, `Tooltip`, `Toast`, `Tabs`, `Progress`, `EmptyState`, `Spinner`, `ContextMenu` |
| 工具卡片 | `ToolCard`, `ToolCardResult`, `ToolCardDiff`, `ToolCardProgress`, `ToolCardError` |
| 特殊 | `TodoCard`, `StatusCard`, `SystemCard` |

示例：

```javascript
const query = new anoclaw.ui.Input({ placeholder: 'Search sessions' });
const run = new anoclaw.ui.Button({
  label: 'Run',
  variant: 'primary',
  onClick: () => performSearch(query.value)
});

const field = new anoclaw.ui.FormField({
  label: 'Query',
  input: query.element,
  help: 'Search current plugin data'
});

document.body.append(field.element, run.element);
```

## 插槽挂载

后端 Worker 可通过 `api.ui.mount()` 挂载小块 HTML：

```javascript
await api.ui.mount('settings-bottom', '<div class="my-plugin-status">Ready</div>', {
  id: 'my-plugin-status',
  position: 'append',
  priority: 50
});
```

适合插槽的内容：

- 状态徽章。
- 插件配置入口。
- 轻量过滤器。
- 与当前页面强相关的小面板。

不适合：

- 大型完整应用页面。
- 长文档。
- 覆盖内核导航的自定义布局。

大型 UI 请用 `contributes.pages` 创建插件页面。

## ConfirmDialog 桥接

iframe 内请求原生确认框：

```javascript
function confirmInParent(title, message) {
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    const onMessage = event => {
      if (event.data?.type === 'anoclaw:dialog:result' && event.data.id === id) {
        window.removeEventListener('message', onMessage);
        resolve(Boolean(event.data.result));
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'anoclaw:dialog:confirm', id, title, message }, '*');
  });
}
```

## Session Handoff

插件页面可以把用户带回某个 session，并填入 prompt：

```javascript
window.parent.postMessage({
  type: 'anoclaw:session:handoff',
  id: crypto.randomUUID(),
  sessionId,
  prompt: 'Continue from this plugin result and propose next steps.'
}, '*');
```

## 品牌设计预设

`docs/design-md/<brand>/DESIGN.md` 包含品牌视觉 token 和使用建议。适合：

- 用户明确要求某品牌风格。
- 需要快速生成一个有明确审美方向的插件页面。
- 需要保持颜色、字体、间距、组件质感一致。

选择品牌时：

| 需求 | 可参考 |
|---|---|
| 极简、高级、系统感 | `apple`, `linear.app`, `superhuman` |
| SaaS 控制台、开发工具 | `stripe`, `vercel`, `cursor`, `raycast`, `supabase` |
| 数据密集、企业工具 | `airtable`, `notion`, `clickhouse`, `mongodb` |
| 金融、交易、可信赖 | `coinbase`, `revolut`, `wise`, `binance` |
| 创意、媒体、内容 | `figma`, `runwayml`, `webflow`, `theverge`, `wired` |

使用方式：

1. `Glob docs/design-md/*/DESIGN.md` 找品牌。
2. `Read docs/design-md/<brand>/DESIGN.md`。
3. 抽取颜色、字体、间距、组件语言。
4. 套用到插件页面，但保留 AnoClaw 可用性原则。

## 布局建议

工作台类插件页面常用结构：

```text
Toolbar
  搜索 / 过滤 / 主要操作

Main split
  Left: list / tree / presets
  Right: detail / editor / preview

Footer or status strip
  保存状态 / 错误 / 最近运行
```

避免：

- 大 hero 区。
- 只为装饰的渐变大背景。
- 卡片套卡片。
- 文本塞进过小按钮。
- 只用一种颜色深浅变化构成整个页面。

## 可访问性与可用性

- 所有按钮要有清楚 label 或 `title`。
- 输入框要有 label。
- 空状态要说明下一步动作。
- 错误信息要包含可执行建议。
- 长列表要支持搜索或分组。
- 破坏性操作要确认。
- 页面在 1366px 宽和窄窗口下都不能文字重叠。
