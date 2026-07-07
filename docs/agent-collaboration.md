# 多 Agent 协作模型

> 面向用户、agent 和开发者。解释 AnoClaw 的组织结构、会话树和任务分派方式。

## 角色

| 角色 | 定位 | 典型工作 |
|---|---|---|
| MainAgent | CEO，直接面向用户 | 理解目标、拆任务、分派、整合结果、最终回复 |
| Manager | 领域负责人 | 管理成员、分派子任务、复核结果、向上汇报 |
| Member | 执行专家 | 阅读、实现、验证、报告 |
| SubAgent | 临时助手 | 做一次性研究、隔离验证、局部探索 |

MainAgent 始终存在。Manager 和 Member 是持久团队成员。SubAgent 是临时创建，用完销毁。

## 会话树

AnoClaw 的会话是树状结构：

```text
MainSession: 用户 <-> MainAgent
  ├── SubSession: MainAgent <-> Manager A
  │     ├── SubSession: Manager A <-> Member 1
  │     └── SubSession: Manager A <-> Member 2
  └── SubSession: MainAgent <-> Manager B
```

用户主要在主会话输入。子会话用于 agent 间协作，用户可以查看进展。

关键规则：

- 一个 parent-agent pair 复用一个持久 child session。
- `TaskAssign` 用于启动或排队明确任务。
- `AgentMessage` 用于补充上下文、纠偏、澄清或中断已有任务。
- 不要对同一个子 agent 重复开相同任务。

## 什么时候应该分派

适合分派：

- 范围跨多个模块，需要并行阅读。
- 需要专业分工，例如后端、前端、文档、测试。
- 需要独立复核。
- 主 agent 需要保持总览，避免上下文过载。

不适合分派：

- 单个小文件修改。
- 用户只是问一个直接问题。
- 需求还不清楚。
- 任务强依赖顺序执行，分派会增加协调成本。

## 好的 TaskAssign

每个任务都应包含：

- 目标：完成什么。
- 范围：哪些文件、系统、插件、文档。
- 约束：不要改什么、兼容要求、安全边界。
- 验收：怎样算完成。
- 输出格式：希望子 agent 如何汇报。
- 优先级：紧急程度和是否可并行。

示例：

```text
目标：校准插件 API 文档中的 api.fs 部分。
范围：src/server/core/plugin-host/PluginAPI.ts、RpcDispatcher.ts、docs/plugin-api.md。
约束：不要修改运行时代码，只改文档。
验收：文档准确描述 sessionId、workspace 限制、grep/glob 返回类型。
输出：列出发现的不一致和最终修改摘要。
```

## 汇报格式

子 agent 汇报应短而可审查：

```text
Done:
- 修改了 X
- 验证了 Y

Evidence:
- 命令/测试/文件引用

Risks:
- 剩余风险或未验证项
```

Manager 向 MainAgent 汇报应更决策化：

```text
完成：插件 API 文档已校准。
验证：对照 PluginAPI.ts、RpcDispatcher.ts；构建通过。
注意：addPage 仍是轻量辅助方法，生产页面建议 manifest 声明。
```

## 与 memory 的关系

协作过程中发现的长期事实可以写入 memory，例如：

- 用户偏好某种 UI 风格。
- 项目约定某类插件命名。
- 团队长期采用某种验证流程。

不要把每次任务进度写入 memory。任务状态留在会话和任务系统里。

## 与 docs 的关系

如果协作产出的是通用知识，应更新 docs：

- “如何调试插件页面空白”
- “api.fs 的路径规则”
- “插件热重载的真实行为”
- “AnoClaw 多 agent 的最佳实践”

如果只是这个项目/用户的个性事实，应写 memory。
