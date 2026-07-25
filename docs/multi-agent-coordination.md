# AnoClaw 3.0 协调平面

> 本文是多 Agent 执行协议。产品概念先读 [agent-collaboration.md](agent-collaboration.md)。

## 单一事实源

公司事件写入 `data/v3/company/events.jsonl`，每项 Work 写入独立 JSONL 事件流，Session transcript 单独顺序追加。投影可删除后重建，不是事实源。

事件在 fsync 成功后才通知 REST/WebSocket/Scheduler。所有写入携带单调 revision；冲突返回 409，非法状态返回 422。

## Task 状态

```text
pending -> ready -> claimed -> running -> submitted -> verifying -> completed
                                  |            |            |
                                  +-> failed   +------------+-> revision_required
                                  +-> blocked                    |
                                  +-> cancelled                  +-> next Run
```

依赖只有在前置 Task 持久化为 `completed` 后解除。TaskClaim 只记录意向；Scheduler 才能原子创建 Run 和 Run Session。

## Team 工具

| 目的 | 工具 |
|---|---|
| Team 生命周期 | `TeamCreate`, `TeamUpdate`, `TeamStatus`, `TeamDelete` |
| 成员成长 | `TeamMemberAdd`, `TeamMemberUpdate`, `TeamMemberRemove`, `AgentList` |
| 工作拆分 | `MissionCreate`, `TaskCreate`, `TaskAssign`, `TaskClaim` |
| 状态与结果 | `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskVerify` |
| 通信 | `AgentMessage` |
| 非 Agent 进程 | `JobList`, `JobOutput`, `JobStop` |

工具身份完全由服务端 `V3ToolExecutionRegistry` 注入。模型不能通过参数伪造 Company、Team、Work、Task、Run、Agent 或 Session 身份。

## Workspace 保护

只读任务禁止写工具。写任务必须声明 workspace 相对 `writeScope`；没有精确范围时使用 `"."`。祖先/子路径冲突，互不重叠的路径可并行。

每次工具调用写入 WAL，记录 prepared、started、finished、transcript_committed。重启时，未确认的写操作进入 `recovery_required`，不会盲目重放。

## 消息投递

每名接收者有独立递增序号。投递在 LLM turn 之前写入 transcript 并变为 consumed；只有消费该消息的 turn 成功提交后才能 acknowledged。中断或崩溃会恢复为 delivered，使用相同消息 ID 进入新 turn，避免重复注入。
