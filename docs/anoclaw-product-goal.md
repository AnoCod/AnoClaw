# AnoClaw Product Goal

> 当前核心方向：先把 AnoClaw 本体做得足够强大、稳定、兼容、智能，再扩展官方业务插件和行业能力包。插件生态必须开放，AnoClaw 不应该限制插件开发者能做什么，而应该提供更多稳定 API、生命周期保障和 Workspace/Artifact 基础设施，让插件开发者更容易做成事。

## 开发期原则

AnoClaw 目前仍处于开发阶段，没有真实用户需要迁移。因此当旧接口、旧数据结构、旧 UI 或旧交互妨碍长期目标时，可以优先重构或替换，不需要为了历史兼容牺牲正确架构。

近期不要急着堆行业能力包、老人模式、儿童模式或大量官方插件。它们是未来验证场景，不是当前主线。当前主线是：

```text
强核心 Agent
→ 强 Workspace / Artifact
→ 强插件 API 与生命周期
→ 稳定能力路由与任务执行
→ 再发展官方插件、社区插件、行业包
```

## 核心定位

AnoClaw 不是单纯的插件合集，也不应该只是技术用户的 Agent 工具。AnoClaw 本体应该先回答：

> 用户说一句自然语言，我能不能理解真实目标，利用当前 workspace、memory、tools、skills 和插件能力，稳定地产出可继续修改的结果？

核心闭环：

```text
用户一句话
→ TaskResolver 理解任务
→ CapabilityRegistry 匹配本体能力 / 插件能力
→ Agent 选择计划、工具、workspace、memory、artifact
→ 执行任务并自检
→ 生成 Artifact / Workspace Tab 成品
→ 用户继续自然语言修改
```

## 一、本体优先级

近期开发优先保证 AnoClaw 不依赖大量官方插件也足够强：

- Agent 足够聪明：能理解意图、规划步骤、选择工具、检查结果、失败恢复。
- Workspace 足够强：文件树、编辑器、浏览器、终端、预览、Artifact 都能自然协同。
- Artifact 足够通用：PPT、文档、PDF、表格、网页报告、图片、自动化结果等都可以以统一方式预览、下载、继续修改。
- TaskResolver 足够稳：能判断任务类型、能力缺口、默认值、是否需要追问、是否可以先做。
- CapabilityRegistry 足够开放：本体能力和插件能力都能被统一发现、排序、推荐。
- Memory 足够有用：记住偏好、交付习惯、workspace 选择、输出格式，而不仅是聊天历史。
- 插件生命周期足够可靠：激活、取消、reload、删除插件时，不留下旧工具、旧 route、旧 slot、旧 prompt、旧事件订阅。
- 兼容性足够好：Windows 本地路径、编码、workspace 文件、Electron 环境、网络失败、插件崩溃都要可恢复。

## 二、Workspace 与 Artifact

普通用户要的是结果，不是工具日志。AnoClaw 的成品体验应该尽量汇聚到 Workspace，而不是让每个插件各做一套割裂 UI。

原则：

- Workspace 的 TabPanel 要成为通用成品预览和工作台。
- 所有插件生成的预览尽量复用 Workspace TabPanel。
- 插件可以提供自己的页面，但文件预览、Markdown 报告、图片、PDF、Office 输出、表格、代码 diff 等通用能力应该优先走 Workspace/Artifact 基础设施。
- ArtifactPanel / Workspace tabs 应支持预览、打开源文件、下载、版本、继续修改。
- 插件只需要声明 Artifact 文件、preview、metadata，AnoClaw 本体负责展示、索引、打开和后续编辑入口。

工程目标：

- `src/server/core/artifacts/ArtifactManager.ts`
- `data/artifacts/<sessionId>/<artifactId>/`
- WebSocket 事件：`artifact_created`、`artifact_updated`、`artifact_preview`、`artifact_done`
- 前端：Workspace TabPanel 与 ArtifactPanel 深度融合
- 插件 API：允许插件创建 Artifact、打开 Workspace tab、注册 preview provider、更新 Artifact 状态

## 三、能力系统 CapabilityRegistry

插件不能只暴露工具，也应该能声明“我能帮用户完成什么事”。但能力系统不能变成限制插件的框架。

原则：

- Capability 是给 AnoClaw 和普通用户理解能力用的，不是限制插件开发者的边界。
- 插件可以声明 capability，也可以只声明 tool/page/route/event/provider。
- AnoClaw 不应该要求插件必须属于固定行业、固定 UI、固定任务类型。
- CapabilityRegistry 负责统一发现、排序、推荐、缺能力提示。

能力声明示例：

```json
{
  "id": "presentation.create",
  "title": "制作演示文稿",
  "domain": "office",
  "triggers": ["做PPT", "制作课件", "汇报材料", "路演"],
  "inputs": ["主题", "受众", "页数", "风格"],
  "outputs": ["pptx", "pdf", "preview_images"],
  "tools": ["office.create_pptx"],
  "examples": [
    "帮我做一个介绍太阳系的小学生PPT",
    "做一份 AI Agent 项目汇报 PPT"
  ]
}
```

工程目标：

- `src/shared/types/capability.ts`
- `src/server/core/capability/CapabilityRegistry.ts`
- `src/server/core/capability/TaskResolver.ts`
- `GET /api/v1/capabilities`
- `POST /api/v1/tasks/resolve`
- 插件 `plugin.json` 支持 `contributes.capabilities`

## 四、任务解析 TaskResolver

TaskResolver 是本体智能的一部分，不应该只服务插件推荐。它负责判断：

- 用户是在聊天、创作、分析、写文件、整理文件、研究网页、修改代码、自动化操作，还是需要打开 workspace？
- 当前 AnoClaw 本体能不能做？
- 是否有对应插件能力？
- 是否缺少必要信息？
- 能否用默认值先开始？
- 是否应该用 workspace 当前文件、选区、浏览器 tab 或 Artifact 作为上下文？
- 是否需要推荐插件，或者先做降级版本？

体验原则：

- 不要一上来问一堆问题。
- 能先做就先做，缺失信息用合理默认值或占位内容。
- 用户说“这个”“这里”“当前文件”时，优先看 Workspace/Editor Context。
- 面向普通用户时隐藏工具细节；面向专业用户时允许展示工具、日志和插件路径。

## 五、插件平台开放原则

AnoClaw 不能替插件开发者决定他们只能做什么。平台要做的是提供能力、稳定性和安全边界，而不是业务限制。

插件开发者应该可以自由扩展：

- tools
- pages
- commands
- api routes
- skills
- capabilities
- prompt sections
- workspace tabs / preview providers
- artifact producers
- memory providers
- settings panels
- update channels
- MCP / browser / external service integrations
- custom workflows and automation

平台应开放更多 API：

- Workspace API：读写文件、打开 tab、创建/更新编辑器视图、获取当前文件/选区/浏览器状态。
- Artifact API：创建 Artifact、追加文件、设置 preview、更新状态、打开预览、绑定后续修改。
- Tool API：注册、注销、执行本体工具、声明风险等级、声明是否只读。
- UI API：挂载 slot、卸载 slot、注册 page、注册 Workspace tab provider。
- Route API：注册/注销 HTTP routes。
- Event API：订阅/取消订阅内核事件。
- Memory API：读写偏好、项目记忆、插件私有记忆。
- LLM API：调用当前模型、请求结构化输出、使用系统配置。
- Settings API：声明配置、读写插件配置。
- Update API：检查插件版本、下载安装、回滚。

必要边界：

- 不做业务形态限制。
- 不限制插件行业、UI、工作流或能力类型。
- 但必须保留最小安全边界：进程隔离、权限提示、危险操作确认、路径保护、用户数据保护、崩溃恢复、贡献注销。

## 六、插件生命周期要求

用户可能激活、取消、reload、删除插件。插件贡献必须可注销，宿主也要兜底清理。

插件如果注册了以下内容，必须能在取消或删除时清掉：

- tools
- api routes
- event subscriptions
- prompt sections
- extension points
- UI slots
- Workspace tabs / preview providers
- background tasks
- timers / watchers
- temporary files when appropriate

宿主层也必须按 `pluginName` 做兜底清理，避免插件崩溃或开发者忘记 dispose 时污染系统。

## 七、默认能力与官方插件策略

短期不再把“开发更多官方业务插件”作为主线。官方插件应该先作为验证本体能力的样板，而不是替代生态。

保留和维护已有官方样板：

- `anoclaw-office`
- `anoclaw-pdf`
- `anoclaw-files`
- `anoclaw-web-research`

近期官方插件的目标：

- 验证 CapabilityRegistry。
- 验证 TaskResolver。
- 验证 Artifact / Workspace Tab 预览。
- 验证插件生命周期注销。
- 验证插件 API 是否够用。

暂缓：

- 大规模行业能力包。
- 复杂老人模式。
- 复杂儿童模式。
- 为特定行业预设大量官方插件。

未来再做：

- 教育、法律、财务、设计、医疗等行业包。
- 老人/儿童专门交互模式。
- 更完整的官方日常能力包。

## 八、用户模式

近期用户模式只保留本体交互层面的必要模式，不把模式本身做成大工程。

近期重点：

- 简洁模式：减少噪音、少按钮、默认隐藏工具细节。
- 办公模式：优先 Artifact、文档、表格、报告、文件处理。
- 编程模式：优先 Workspace、当前文件/选区、代码搜索、测试、Git 状态。
- 专业模式：显示工具、日志、插件、MCP、API、工作流。

暂缓：

- 老人模式。
- 儿童模式。
- 行业模式。

这些模式未来可以由插件包或可访问性设置扩展，不作为当前阶段牵引架构的重点。

## 九、Memory 升级

Memory 不能只记聊天历史，要记用户偏好和交付习惯。

示例：

```json
{
  "presentationStyle": "简洁商务",
  "defaultSlideCount": 10,
  "audience": "公司内部管理层",
  "language": "中文",
  "favoriteOutputFolder": "D:/Documents/AnoClaw",
  "preferredWorkspace": "F:/Projects/AnoClaw"
}
```

以后用户说“再做一个类似的”，AnoClaw 应该知道“类似”是什么意思。

## 十、缺能力时的处理

当用户请求当前做不了的事时，AnoClaw 不应该只说“我没有这个工具”，而应该说明缺什么能力、推荐什么插件，以及可否先做降级版本。

示例：

> 这个任务需要“视频剪辑能力”。当前未安装相关插件。我可以为你推荐相关插件，或者先生成脚本和分镜。

处理链路：

```text
无能力
→ 查 Capability Marketplace
→ 推荐插件或降级方案
→ 用户确认安装或继续降级执行
→ 安装后继续原任务
```

## 十一、自动更新系统

AnoClaw 本体、官方自带插件、社区插件都应该能被独立检查和更新。

目标体验：

- AnoClaw 可以检查 GitHub 仓库是否有新版本。
- 有新版本时，用户可以选择自动下载并更新。
- 官方插件可以独立更新，不必每次等待主程序发布。
- 社区插件可以通过社区插件仓库检查版本、下载、更新和回滚。
- 更新必须保护用户数据、会话、设置、Memory 和插件本地存储。

工程方向：

- `UpdateManager`：检查 AnoClaw 本体版本，下载更新包，校验签名或哈希。
- `PluginUpdateManager`：检查官方插件和社区插件版本。
- 插件 manifest 增加 `repository`、`updateUrl`、`channel`、`checksum`。
- 插件市场增加更新元数据，支持 stable/beta channel。
- 设置页提供更新状态、更新日志、更新按钮和失败恢复提示。

社区插件更新链路：

```text
检查社区插件仓库
→ 对比本地 plugin.json 版本
→ 下载插件包
→ 校验 manifest / checksum
→ 停用旧插件并清理贡献
→ 安装新插件
→ 失败则回滚旧版本
```

## 十二、前端 UI 与多语言

当前前端 UI 仍有大量硬编码英文。目标不是一次性翻完，而是逐步迁移到按地区拆分的语言文件。

工程方向：

- 设置页支持切换语言。
- 文案通过稳定 key 索引，而不是组件里硬编码。
- 每个地区语言独立文件，例如 `zh-CN`、`en-US`、`ja-JP`。
- 新增或重构前端 UI 时，优先使用语言 key，旧页面逐步迁移。
- 涉及前端 UI 时参考根目录 `design.md`：深色 Raycast 风、紧凑产品界面、hairline 边框、8px 左右圆角、少量高饱和强调色。

## 十三、推荐实现顺序

第一阶段：本体稳定与 Agent 智能。

- 稳定 AgentLoop / AgentRuntime。
- 强化 TaskResolver。
- 强化工具选择、失败恢复、结果自检。
- 强化 Workspace/Editor Context。
- 强化测试、构建、启动、崩溃恢复。

第二阶段：Workspace TabPanel 与 Artifact 工作区。

- 让 Workspace TabPanel 足够强大，承载大多数插件预览。
- 打通 Artifact 文件、preview、metadata、版本、打开、下载、继续修改。
- 插件生成的成品优先进入 Workspace/Artifact。

第三阶段：开放插件 API 与生命周期。

- 扩展 Workspace API、Artifact API、UI API、Route API、Event API、Memory API、Settings API、Update API。
- 统一插件贡献注册与注销。
- 完善插件开发文档、示例和测试。
- 不限制插件开发者的行业、业务、UI、工作流。

第四阶段：能力路由与插件市场。

- 所有本体能力和插件能力进入 CapabilityRegistry。
- AgentLoop 执行前先过 TaskResolver。
- 缺能力时推荐插件或降级执行。
- 插件市场支持搜索、安装、更新、回滚。

第五阶段：官方插件样板完善。

- Office/PDF/files/web-research 作为验证样板继续维护。
- 不急着扩展大量官方业务插件。
- 只有当本体和 API 证明稳定后，再开发新的官方插件。

第六阶段：行业能力包和特殊人群模式。

- 教育包、法律包、财务包、设计包、程序员包等。
- 老人模式、儿童模式、复杂无障碍体验。
- 这些是后续生态层，不是当前阶段的核心牵引。

## 最终判断标准

AnoClaw 完成这次进化，不是看插件数量，而是看这些能力是否成立：

- 不装很多插件时，AnoClaw 本体仍然稳定、聪明、可用。
- Agent 能理解用户目标，选择工具，使用 workspace，上下文不乱。
- Workspace TabPanel 能承载大多数成品预览。
- Artifact 能被预览、打开、下载、继续修改。
- 插件开发者能通过开放 API 做复杂能力，而不被固定模板限制。
- 插件激活、取消、reload、删除后，系统不会留下脏工具、脏 route、脏 slot 或脏 prompt。
- 缺能力时，AnoClaw 能说明缺口、推荐插件或先做降级版本。
- 自动更新保护用户数据并支持本体、官方插件、社区插件独立更新。

真正的目标是：

> 用户不需要理解 Agent，AnoClaw 理解用户。
> 用户不需要理解插件，AnoClaw 自动发现能力。
> 插件开发者不需要被 AnoClaw 限制，AnoClaw 提供开放稳定的能力底座。
> 用户不需要关心工具调用，AnoClaw 在 Workspace 中交付成品。
