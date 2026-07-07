# AnoClaw Product Goal

> 长期方向：用户不需要理解 Agent、插件或工具调用。AnoClaw 应该理解用户，一句话判断真实目标，自动找到能力，补齐必要信息，交付可预览、可下载、可继续修改的成品。

## 开发期原则

AnoClaw 目前仍处于开发阶段，没有真实用户需要迁移。因此当旧接口、旧数据结构、旧 UI 或旧交互妨碍产品目标时，可以优先重构或替换，不需要为了历史兼容牺牲正确的长期架构。

## 核心定位

AnoClaw 未来不应该只回答“我有哪些工具”，而应该回答：

> 用户说一句自然语言，我能不能判断他的真实目标，自动找到能力，补齐信息，生成成品，并允许继续修改？

核心闭环：

```text
用户一句话
→ TaskResolver 理解任务
→ CapabilityRegistry 匹配能力
→ 自动选择 skill / tool / plugin / memory
→ 执行任务
→ 生成 Artifact 成品
→ 用户继续自然语言修改
```

## 一、能力系统 CapabilityRegistry

插件不能只暴露工具，必须声明“我能帮用户完成什么事”。普通用户看到的是能力，不是插件清单。

能力声明示例：

```json
{
  "id": "presentation.create",
  "title": "制作演示文稿",
  "domain": "office",
  "triggers": ["做PPT", "制作课件", "汇报材料", "路演"],
  "inputs": ["主题", "受众", "页数", "风格"],
  "outputs": ["pptx", "pdf", "preview_images"],
  "tools": ["office.create_pptx", "web.search", "image.generate"],
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

## 二、任务解析 TaskResolver

在 `AgentRuntime` 或 `AgentLoop` 前增加任务理解层。

它负责判断：

- 用户想要的是聊天、文件、自动化、搜索、分析，还是创作？
- 是否有对应 capability？
- 是否缺少必要信息？
- 能否用默认值开始？
- 是否需要推荐插件？
- 是否应该进入某个专业模式？

示例：

> 帮我做一个公司年终总结 PPT

期望解析：

```json
{
  "intent": "create_artifact",
  "capability": "presentation.create",
  "artifactType": "pptx",
  "missingFields": ["公司业务", "受众", "页数"],
  "canStartWithDefaults": true
}
```

AnoClaw 应该尽量先开始，而不是一上来追问一堆问题：

> 我先按“公司内部汇报、10 页、商务简洁风”开始做，缺少的公司信息我会用占位内容标注，你可以之后替换。

## 三、Artifact 成品系统

普通用户要的是结果，不是工具日志。

Artifact 类型包括：

- PPT
- Word
- PDF
- Excel
- 图片
- 网页报告
- 表格分析
- 思维导图
- 自动化结果

工程目标：

- `src/server/core/artifacts/ArtifactManager.ts`
- `data/artifacts/<sessionId>/<artifactId>/`
- WebSocket 事件：`artifact_created`、`artifact_updated`、`artifact_preview`、`artifact_done`
- 前端组件：`ArtifactPanel`

用户体验：

```text
“帮我做个 PPT”
→ AnoClaw 生成 PPT 预览
→ 用户说“第三页更简洁一点”
→ AnoClaw 修改第三页
→ 用户下载 .pptx
```

## 四、默认日常能力包

默认安装官方基础插件，避免普通用户一上来就缺能力。

优先级：

1. `anoclaw-office`：PPT、Word、Excel
2. `pdf`：阅读、总结、合并、导出、转图片
3. `web-research`：搜索、资料整理、引用来源
4. `image`：生成图片、改图、OCR、截图理解
5. `files`：文件整理、批量重命名、查找、归档
6. `developer` / `coding`：代码仓库理解、修 bug、实现功能、测试、代码评审、GitHub/PR/CI 协作
7. `data-analysis`：CSV/Excel 分析、图表、报告
8. `browser-automation`：网页操作、表单填写、重复任务
9. `life-assistant`：计划、清单、提醒、旅行、购物对比
10. `education`：保留基础儿童讲解、作业辅导、课件能力，但近期不做复杂儿童模式

## 五、用户模式

AnoClaw 要面对普通办公用户、编程用户、专业用户，也要保留老人和儿童能用的基础体验，但近期重点不是复杂儿童模式。

内置模式：

- 简洁模式：大字、少按钮、语音优先、一步一步确认
- 办公模式：PPT/Word/Excel/会议/邮件优先
- 编程模式：代码仓库、实现功能、修 bug、测试、GitHub/PR/CI 优先
- 专业模式：显示工具、日志、插件、MCP、工作流
- 儿童基础模式：安全内容、耐心解释、易懂表达；近期只做基础支持，不作为主线投入
- 行业模式：由插件包提供，比如法律、医疗、教育、财务、设计

模式影响：

- 系统提示词
- 默认能力排序
- 是否主动追问
- 解释深度
- UI 复杂度
- 安全策略

## 六、Memory 升级

Memory 不能只记聊天历史，要记用户偏好和交付习惯。

示例：

```json
{
  "presentationStyle": "简洁商务",
  "defaultSlideCount": 10,
  "audience": "公司内部管理层",
  "language": "中文",
  "childAge": 8,
  "favoriteOutputFolder": "D:/Documents/AnoClaw"
}
```

以后用户说“再做一个类似的”，AnoClaw 应该知道“类似”是什么意思。

## 七、缺能力时的处理

当用户请求当前做不了的事时，AnoClaw 不应该只说“我没有这个工具”，而应该说明缺什么能力、推荐什么插件，以及可否先做降级版本。

示例：

> 这个任务需要“视频剪辑能力”。当前未安装相关插件。我可以为你推荐并安装官方视频插件，或者先生成脚本和分镜。

处理链路：

```text
无能力
→ 查 Capability Marketplace
→ 推荐插件
→ 用户确认安装
→ 安装后继续原任务
```

## 八、自动更新系统

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
→ 停用旧插件
→ 安装新插件
→ 失败则回滚旧版本
```

## 九、前端 UI 与多语言

当前前端 UI 仍有大量硬编码英文。目标不是一次性翻完，而是逐步迁移到按地区拆分的语言文件。

工程方向：

- 设置页支持切换语言。
- 文案通过稳定 key 索引，而不是组件里硬编码。
- 每个地区语言独立文件，例如 `zh-CN`、`en-US`、`ja-JP`。
- 新增或重构前端 UI 时，优先使用语言 key，旧页面逐步迁移。
- 涉及前端 UI 时参考根目录 `design.md`：深色 Raycast 风、紧凑产品界面、hairline 边框、8px 左右圆角、少量高饱和强调色。

## 十、推荐实现顺序

第一阶段：打通 PPT 作为样板任务。

这是最好的突破口，因为它同时验证任务理解、插件能力、成品系统和修改闭环。

要做：

- Capability schema
- `presentation.create`
- PPT 插件
- ArtifactPanel
- `.pptx` 生成与预览
- 用户自然语言修改

第二阶段：扩展 Office/PDF。

- Word
- PDF
- Excel
- 代码仓库理解、修 bug、实现功能、测试、代码评审

第三阶段：能力路由全面接入。

- 所有插件声明 capability
- AgentLoop 执行前先过 TaskResolver
- 缺能力时推荐插件或降级执行

第四阶段：用户模式与新手体验。

- 简洁模式
- 办公模式
- 编程模式
- 专业模式
- 儿童基础模式

第五阶段：插件市场智能推荐。

- 用户不懂插件没关系，AnoClaw 自己知道缺什么能力。

第六阶段：行业能力包。

- 教育包
- 法律包
- 财务包
- 设计包
- 程序员包

## 最终判断标准

AnoClaw 完成这次进化，不是看插件数量，而是看这些场景能不能自然完成：

- “帮我做个十页 PPT”
- “把这个 PDF 总结成一页报告”
- “帮我整理这个文件夹”
- “帮我修一下这个 bug 并跑测试”
- “帮我 review 这个 PR”
- “把这个 Excel 做成图表并写分析”
- “帮我规划三天上海旅行”
- “根据这些资料写一份合同初稿”
- “我不懂插件，你自己看需要什么就用什么”

真正的目标是：

> 用户不需要理解 Agent，AnoClaw 理解用户。
> 用户不需要理解插件，AnoClaw 自动发现能力。
> 用户不需要关心工具调用，AnoClaw 交付成品。
