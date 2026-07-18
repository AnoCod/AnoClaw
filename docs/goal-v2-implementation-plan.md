# AnoClaw Goal v2 实施计划

## 1. 目标

把当前“持续重复运行的会话模式”升级为一个可信、可控、可恢复、以 Workspace 交付物为核心的长期目标系统。

用户给出目标、验收标准、Workspace 和执行边界后，AnoClaw 应持续推进；每一轮必须留下结构化进展或明确终态，并在完成、阻塞、需要确认、失败或预算耗尽时停止自动运行。

本轮不重做通用项目管理系统，也不把 Goal 做成提醒器。核心定位是：

> 以 Workspace 为事实源、在明确边界内持续执行、用可验证成果汇报的长期任务模式。

## 2. 当前问题

### P0：必须解决

1. Goal 只有 `active / paused / deleted`，无法真正完成、阻塞、失败或等待验收。
2. 活跃 Goal 每 3 秒无条件再次调用模型，没有预算、最大轮次、失败退避和熔断。
3. 启动 Goal 会静默切换到 Auto Edit，并自动批准工具确认，高风险操作边界不可信。
4. Pause/Delete 只更新 metadata，不会立即中断当前 LLM 或工具；Stop 又不会同步暂停 Goal。
5. Goal 子循环会短暂删除会话活动标记，存在同一 Session 双循环和重复副作用风险。
6. 内部 Goal 指令被保存为普通用户消息，污染聊天历史并增加上下文成本。
7. 创建界面只有 objective，没有验收标准、Workspace、权限和预算说明。

### P1：本轮一并解决

1. 重启或刷新后 active Goal 不能可靠恢复。
2. Goal metadata 更新未统一走 Session 锁，失败可能被 UI 当成成功。
3. UI 采用乐观更新，缺少 pending、失败回滚和权威 ACK。
4. 主卡片用 run count 代替成果进度，缺少本轮摘要、下一步、证据和剩余预算。
5. 缺少持久化的 waiting user / waiting confirmation / needs review 状态。

## 3. 产品范围

### 3.1 Goal 执行合约

创建或编辑 Goal 时保存：

- Outcome：目标结果。
- Done when：验收标准。
- Workspace：默认固定为创建时的根 Session Workspace。
- Permission：默认使用 Safe Auto；Workspace 内低中风险操作可自动执行，高风险和关键操作必须确认。
- Limits：最大运行轮次、最大连续失败次数、运行间隔。
- Completion：默认完成后进入 Needs Review，由用户验收关闭。

### 3.2 状态机

正式状态：

```text
active
  -> paused
  -> waiting_user
  -> waiting_confirmation
  -> waiting_review
  -> blocked
  -> failed
  -> budget_exhausted
  -> deleted

waiting_review
  -> completed
```

恢复路径：

- `paused / waiting_user / waiting_confirmation / blocked / failed / budget_exhausted -> active`
- `waiting_review -> completed`（用户验收）
- `waiting_review -> active`（继续修改）
- 任意非 deleted 状态可进入 `deleted`

### 3.3 每轮运行报告

新增 Goal 专用结构化工具，Agent 每一轮结束前必须提交：

- outcome：`progress / waiting_user / waiting_review / blocked / failed`；`waiting_confirmation` 由真实工具确认流程管理，Agent 不得伪造。
- summary：本轮完成了什么。
- evidence：文件、图片、文档、测试或其他 Workspace 证据。
- nextStep：下一步。
- progress：可选的 0–100 进度估计。
- reason：阻塞、失败或等待原因。

Agent 不能直接把 Goal 标记为最终 completed；默认只能提交 `waiting_review`，由用户验收。

### 3.4 运行安全

- 每轮开始进行原子 claim，生成 `runId` 并递增版本。
- 同一 Goal/Session 只允许一个 runner。
- 达到最大轮次时进入 `budget_exhausted`。
- 连续失败使用指数退避；达到阈值进入 `failed`。
- capability routing 缺少工具或关键输入时直接进入 `blocked`，不再循环重试。
- 如果一轮结束未提交 Goal 报告，将其视为无进展失败并计入熔断。
- Pause、Delete 和 Stop 必须先持久化状态，再 Abort 当前执行。
- 运行中的会话锁覆盖 Sleep 和所有子循环，防止竞争。

### 3.5 权限安全

- Goal 不再强制修改根 Session 的权限模式。
- Goal 使用创建合约中保存的权限模式，默认 Safe Auto。
- Auto Edit 也不能自动批准 High/Critical 工具。
- Goal 模式不得通过“active”状态绕过 Tool 自身的确认检查。
- 未确认的高风险操作进入持久等待状态；超时不能自行猜测为批准。

### 3.6 聊天与 Workspace

- Goal kick 和 continuation 是内部控制消息，不写成普通用户聊天记录。
- 聊天只展示运行摘要、工具活动、证据和终态。
- evidence 中的 Workspace 文件沿用现有富内容链接能力：点击文件在 Workspace IDE 打开，图片可预览。
- Goal 绑定创建时 Workspace；Workspace 变化必须通过编辑合约明确更新。

## 4. 数据模型

`SessionGoal` 计划包含：

- 标识：`goalId`, `version`
- 合约：`objective`, `acceptanceCriteria`, `workspace`, `permissionMode`
- 限制：`maxRuns`, `maxConsecutiveFailures`, `wakeIntervalMs`
- 状态：`status`, `statusReason`, `createdAt`, `updatedAt`, `completedAt`, `deletedAt`
- 使用量：`runCount`, `consecutiveFailures`, `nextRunAt`
- 当前运行：`currentRunId`, `currentRunStartedAt`, `lastReportedRunId`
- 最近成果：`progress`, `lastSummary`, `nextStep`, `evidence`, `lastError`
- 上下文：`lastWorkspace`, `lastPermissionMode`, `lastEffort`, `lastUserMode`

兼容旧 metadata：加载旧 Goal 时补齐新字段，不要求用户迁移数据文件。

最近运行记录保留固定上限，避免 `meta.json` 无限增长。

## 5. 实施阶段

### Phase A：模型与持久化

1. 扩展共享类型和 WebSocket payload。
2. 在 SessionManager 中增加标准化、迁移、合法状态转换和带锁更新。
3. 实现 begin/report/fail/transition 等原子 Goal 操作。
4. 增加模型与持久化单元测试。

验收：旧 Goal 可加载；并发更新不丢失；终态和预算状态可持久化。

### Phase B：运行时可靠性

1. 新增 GoalReport 工具并在活跃 Goal 运行时自动加入可用工具。
2. 重写 continuation：有限运行、正式报告、预算、退避、熔断。
3. 修复 Sleep 窗口活动标记。
4. capability 缺失转 blocked。
5. 移除内部 prompt 的用户消息持久化。
6. active Goal 在客户端恢复 Session 后自动进行一次隐藏 kick。

验收：完成候选会停止；失败不会形成 3 秒错误风暴；刷新后不产生可见内部消息；同 Session 不会双跑。

### Phase C：权限与控制

1. 移除强制 Auto Edit 和 active Goal 自动批准。
2. High/Critical 始终确认。
3. Pause/Delete/Stop 同步 Abort 和服务端权威状态。
4. 用户回复后可从 waiting_user 恢复；拒绝确认后进入等待或阻塞。

验收：暂停能终止当前执行；停止后 UI 与服务端一致；高风险工具不能静默执行。

### Phase D：Goal UI/UX

1. 创建/编辑弹窗升级为执行合约。
2. UI 改为等待服务端 ACK，显示 pending 和错误。
3. Mode 上拉菜单作为 Goal 唯一入口；输入框不常驻 Goal 卡。已有 Goal 以紧凑状态入口打开按需详情面板，在面板中展示状态、进度、验收标准、Workspace、当前摘要、下一步、证据和预算。
4. 提供 Pause/Resume、继续修改、验收完成、删除等符合状态的操作。
5. 提升字号、按钮点击区域、label 关联、aria-live 和中文可理解性。

验收：用户在启动前能理解“它会做什么、能改哪里、何时停止”；运行中能看到成果而非只有轮次。

### Phase E：验证与交付

1. 运行 Goal 相关单元测试、全量测试和 TypeScript 检查。
2. 只在全部代码与测试收口后执行一次正式清理、完整构建和 Windows 打包。
3. 用 `dev-update.cjs` 热更新 `D:\ANOCLAW`，不覆盖用户 `data/` 和 `config/`。
4. 启动 `D:\ANOCLAW\AnoClaw.exe` 实测：创建、暂停、恢复、完成候选、验收、预算耗尽、错误熔断、刷新恢复、Workspace 文件链接和图片预览。
5. 检查日志和打包产物，确认无测试数据、密钥或用户配置泄漏。
6. 审阅 diff，提交并推送当前分支。

## 6. 测试矩阵

### 单元与集成

- 旧 Goal metadata 迁移。
- 合法与非法状态转换。
- 最大轮次和 budget exhausted。
- 连续错误退避与熔断。
- 每轮结构化报告和 waiting review。
- 一轮未报告时的无进展处理。
- Sleep 期间用户发消息不会创建第二 runner。
- Pause/Delete/Stop 在 Sleep、LLM、工具执行阶段生效。
- High/Critical 工具确认策略。
- 内部 Goal 消息不写入用户历史。
- 快速 start/edit/pause/resume 不产生状态回退。
- Workspace 固定与 evidence 规范化。

### 实机

- 创建执行合约后只启动一个 Goal runner。
- 目标完成后进入“待验收”且停止继续调用。
- 点击证据文件在 Workspace IDE 打开。
- 图片证据在会话中正常预览。
- 暂停后当前动作停止；恢复后从最后状态继续。
- 达到预算或连续失败阈值后停止并给出清楚原因。
- 重启应用后 Goal 状态、摘要和证据仍存在。

## 7. 完成标准

只有同时满足以下条件才视为本轮完成：

1. P0/P1 范围实现，没有保留无限循环、静默权限提升或伪完成状态。
2. Goal 相关测试、全量测试和 TypeScript 检查通过。
3. 正式打包成功，安装包无数据/config 泄漏。
4. `D:\ANOCLAW` 热更新成功，`AnoClaw.exe` 实机流程通过。
5. Workspace 文件链接和图片预览在 Goal 输出中通过实测。
6. 代码 diff 已审阅，只提交本轮有意修改，并推送当前分支。
