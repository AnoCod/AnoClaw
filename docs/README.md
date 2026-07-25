# AnoClaw 知识库

> 这是 AnoClaw 随包携带的 agent-readable 知识库。它补充 agent 的能力，但不替代 `skills/` 和 `memory/`。

## 怎么使用

当用户的问题涉及 AnoClaw 的用法、插件开发、API、架构、设计、排障或最佳实践时，agent 应先检索这里，再回答或执行。推荐顺序：

1. 先读本文件，确定主题入口。
2. 用 `Grep` 在 `docs/` 内搜索关键词。
3. 用 `Read` 读取最相关的文件。
4. 如果资料过旧，先核对源码或运行结果，再更新文档。

## 知识库分工

| 系统 | 用途 | 不适合 |
|---|---|---|
| `docs/` | 稳定、可复用、面向所有用户的产品知识、开发指南、API、排障、设计预设 | 私人偏好、一次性任务状态、长流程执行步骤 |
| `skills/` | 需要被 agent 主动调用的流程能力、专业工作流、工具使用规程 | 普通参考资料、产品介绍、宽泛知识 |
| `memory/` | 用户偏好、团队约定、项目长期事实、会话沉淀 | 可公开分发的通用文档、API 参考 |

## 主题入口

| 主题 | 先读 | 适合问题 |
|---|---|---|
| 普通用户上手 | [user-guide.md](user-guide.md) | AnoClaw 能做什么、怎么组织任务、怎么和 agent 配合 |
| 多 agent 协作 | [agent-collaboration.md](agent-collaboration.md) | MainAgent、Manager、Member、SubAgent 如何分工 |
| 系统架构 | [architecture-overview.md](architecture-overview.md) | Electron、HTTP/WS、AgentLoop、JSONL、插件隔离 |
| 插件开发 | [plugin-dev.md](plugin-dev.md) | 创建插件、热重载、工具、页面、路由、调试 |
| 插件 API | [plugin-api.md](plugin-api.md) | `api.tools`、`api.llm`、`api.fs`、events、UI、扩展点 |
| 插件 UI / 品牌设计 | [plugin-ui-guide.md](plugin-ui-guide.md) | iframe 页面、tokens、组件、设计预设、布局约束 |
| 排障 | [troubleshooting.md](troubleshooting.md) | 启动无响应、插件不加载、工具失效、页面空白、构建问题 |
| docs 维护规则 | [agent-docs.md](agent-docs.md) | agent 何时读取、何时维护、如何不污染知识库 |
| 品牌设计预设 | `design-md/<brand>/DESIGN.md` | 按品牌风格设计 UI，例如 Apple、Stripe、Linear、Notion |

机器可读索引见 [manifest.json](manifest.json)。

## 检索建议

常见问题可以这样查：

```text
插件工具不出现          -> Grep "工具不出现|registerTool|ToolRegistry" docs/
怎么做插件页面          -> Read docs/plugin-ui-guide.md
api.fs 怎么限制路径      -> Grep "api.fs|workspace" docs/plugin-api.md
agent 什么时候用 memory  -> Read docs/agent-docs.md
品牌风格怎么选          -> Glob docs/design-md/*/DESIGN.md
启动后双击没反应        -> Read docs/troubleshooting.md
```

## 写作标准

新增或更新文档时：

- 面向未来 agent 和所有用户，避免只记录当前会话临时状态。
- 每份文档要有明确标题、适用人群、操作步骤或决策表。
- API 和行为必须从源码、运行结果或用户确认的信息校准。
- 不写密钥、token、私人路径、不可公开的用户隐私。
- 长流程放 `skills/`，个人偏好放 `memory/`，公共参考放 `docs/`。
