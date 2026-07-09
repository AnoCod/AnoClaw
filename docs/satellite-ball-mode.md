# Satellite Ball Mode

卫星球模式不是第二个主界面，也不应该只是一个装饰性的快捷启动器。它的价值是：主窗口收起后，用户仍然能看见 AnoClaw 是否在工作、是否在等待自己、以及用最短路径回到正确会话。

## Product Positioning

卫星球是后台 agent 工作的轻量驾驶舱。

适合做：

- 查看正在运行的会话、goal、后台任务和等待确认项。
- 快速回到某个最近/正在运行/等待用户的会话。
- 在不展开主窗口的情况下完成一句话继续、停止任务、批准/拒绝低风险确认。
- 在长任务运行时给用户一个明确的状态反馈，避免“最小化后不知道它在干嘛”。

不适合做：

- 完整聊天窗口。
- 大量插件入口。
- 花哨轨道动画堆叠。
- 复制系统托盘已有的打开/退出功能。

## MVP

1. Live status ring

   球体外圈显示当前全局状态：
   - blue: 有 agent 正在运行。
   - amber: 等待用户确认、AskUser、或工具确认。
   - red: 最近任务失败。
   - muted: 空闲。

   球体中心显示一个小数字：运行中任务数或等待项数量。

   V1 已落地：
   - 球体外圈按 idle/running/waiting/goal/paused/done/failed/offline 切换颜色和动画。
   - 球体右下角状态徽标优先显示等待数量，其次显示运行任务数。
   - 无计数但有 goal 时显示 `G`，暂停 goal 时显示 `II`，失败/离线显示 `!`，最近完成显示 `OK`。
   - 小球 hover title / aria-label 同步当前状态，让不展开面板也能知道 AnoClaw 是否在工作或等待。

2. Action satellites

   hover 或单击展开 4-6 个卫星按钮。默认只显示有意义的项：
   - Continue: 回到当前活跃会话。
   - New: 新建快速会话。
   - Waiting: 打开第一个等待用户处理的确认/AskUser。
   - Recent 1/2/3: 最近会话，点击直接选中对应 session。
   - Stop: 当有运行任务时显示，停止当前活跃会话。

3. Mini status panel

   右键或长按球体打开 260px 宽的小面板：
   - 当前活跃会话标题。
   - 当前阶段：thinking / using tool / waiting / done / failed。
   - 当前工具名或 goal 摘要。
   - 最近 3 条完成/失败通知。

4. One-line continue

   小面板底部提供一行输入，只发给当前活跃会话。适合“继续”“停止后总结”“先别动这个文件”这类短指令。

## Useful Highlight Features

1. Waiting Inbox

   最有用的亮点。所有需要用户介入的东西集中在球上：
   - 高风险工具确认。
   - AskUserQuestion。
   - 浏览器权限/下载/弹窗事件。
   - goal 模式卡住或需要选择方案。

   球体变 amber，并显示等待数量。点击 Waiting 后恢复主窗口并定位到对应会话/卡片。后续可以支持在小面板里直接批准或拒绝低风险工具确认。

   V1 已落地工具确认队列：
   - `ToolConfirmationQueue` 暴露当前等待数量和第一个等待项摘要。
   - FloatingBall state 包含 `waitingInbox`，提供 sessionId、toolCallId、标题、风险等级、参数摘要和是否可小窗处理。
   - 小面板在等待时显示 “Needs attention” 卡片，点击正文恢复主窗口并打开对应会话。
   - Safe/Low 风险等待项会在小面板内显示 Approve/Reject，可不展开主窗口直接处理。
   - Medium/High/Critical 仍只做定位和上下文展示，不在小窗内直接批准，避免误触。

   后续增强：
   - AskUserQuestion 等待项接入同一个 inbox。
   - 对明确低风险确认增加小窗内批准/拒绝。
   - 恢复主窗口后滚动到具体确认卡片。

2. Background Task Radar

   长时间 build/test/search/package/run server 时，最小化后仍能看到运行状态。球体外圈转动表示有任务在跑；任务失败时变红，并保留最近失败摘要。

   V1 已落地最近活动雷达：
   - 主窗口从 `tool_execution_completed`、`task_notification`、`command_result`、`error`、`loop_completed` 中提取最近活动。
   - FloatingBall state 包含 `activityItems`，小面板底部优先显示最近 3 条完成/失败摘要。
   - 最近失败会让空闲球体进入 red/failed 状态，最近完成会短期显示 green/done 状态。
   - 点击活动摘要会恢复主窗口并打开对应 session。

3. Goal Pulse

   goal 模式下，球体显示 goal 状态：
   - active: 外圈缓慢呼吸。
   - sleeping: 小月牙/暂停样式。
   - blocked: amber + 等待数量。
   - complete: green/blue 短闪，然后回到 idle。

   V1 已落地：
   - 主窗口推送 `goalPulse`，从等待项、当前任务、active session、最近会话向上找到 root session 的 goal。
   - FloatingBall active goal 使用独立 `goal` phase，不再只伪装成普通 running。
   - 小面板显示 Goal 卡片，包括目标摘要、运行次数、Pause/Resume、Open。
   - Pause/Resume 可以在不展开主窗口的情况下执行；Open 会恢复主窗口并选中 goal 所属 root session。
   - 当 goal 所属 session 有等待确认时，goal 进入 blocked/waiting 态，优先提醒用户处理。

   后续增强：
   - Goal complete 需要服务端显式状态，目前客户端只预留 `completed` 展示。
   - 小球中心可增加运行/等待数字，但不应牺牲当前紧凑交互。

4. Context Return

   卫星按钮不只打开 AnoClaw，而是回到正确上下文：
   - 选中 session。
   - 切到 Sessions 页面。
   - 滚到等待确认/AskUser/最新错误附近。

5. Compact Command

   只保留 3 个真正高频命令：
   - New Session
   - Continue Current
   - Stop Current

   其他功能藏进小面板，避免卫星过多。

6. Selection Helper

   FloatingBall 可以成为选中文本后的最短 AI 入口。V2 采用可靠的剪贴板通道：用户在任意应用里框选文本并复制，主进程会在 FloatingBall 可见时检测剪贴板变化并主动推送给小窗。FloatingBall 会把启动时已有的剪贴板内容当作基线，只在检测到新复制的文本时主动展开小面板，并提供：
   - Translate：翻译成中文，保留代码、路径、专有名词。
   - Polish：按原语言润色，让文字更清晰专业。
   - Summarize：总结要点和下一步建议。
   - Ask Agent：把文本连同用户的一句话问题发给当前会话。

   这个版本的交互原则：
   - 不读取陈旧剪贴板来打扰用户。
   - 只有新复制的文本触发 “Selection captured” 提示。
   - 小面板明确展示将发送给 agent 的文本预览。
   - 捕获状态会保留到用户关闭面板或点击文本动作，避免提示一闪而过。
   - 发送前仍由用户点击 Translate / Polish / Summarize / Ask Agent。

   后续增强：
   - Workspace editor selection bridge：编辑器选区变化后直接同步到 FloatingBall。
   - BrowserView selection bridge：浏览器页内选中文本后显示相同动作。
   - System selection capture：如未来引入安全的全局选区监听，再做“框选即弹出”。高风险/隐私场景必须明确可关闭。

7. Quick Ask

   面板内保留一行输入，适合在主窗口收起时快速发送短问题、继续指令或提醒。它不会变成完整聊天窗口，只负责把一句话送回当前/最近会话。

   V1 已增强为上下文明确的快捷发送：
   - 面板显示 `To` 目标选择器，默认指向等待项、活跃会话、当前任务或最近会话。
   - Quick Ask、Continue、Text Action、Stop 可以在不展开主窗口的情况下把命令送到隐藏的主窗口上下文。
   - Open、Waiting、Recent 仍会恢复主窗口，因为这些动作的目的就是回到具体上下文。
   - 发送成功、停止、失败会通过 FloatingBall 状态栏给出短反馈，避免用户不知道点击后是否生效。

## Implementation Plan

### Phase 1: Make Current Ball Real

- Keep the current 400x400 floating window.
- Replace emoji satellites with SVG/icon text.
- Recent sessions must send `sessionId`, not only an index.
- Main window restores and selects the requested session.
- Add title/status labels that can be read at a glance.

### Phase 2: Shared State Provider

Add one IPC provider:

```ts
floating-ball-state -> {
  activeSessionId: string | null;
  activeTitle: string | null;
  connection: "connected" | "connecting" | "disconnected";
  runningCount: number;
  waitingCount: number;
  activityItems?: Array<{
    id: string;
    sessionId: string | null;
    title: string;
    detail?: string;
    status: "completed" | "failed";
    timestamp: number;
  }>;
  helperNotice?: {
    kind: "info" | "success" | "error";
    text: string;
    timestamp: number;
  };
  waitingInbox?: {
    count: number;
    sessionId: string | null;
    title: string;
    detail?: string;
    riskLevel?: string;
    toolCallId?: string;
    canInlineResolve?: boolean;
  };
  goalPulse?: {
    sessionId: string | null;
    status: "active" | "paused" | "blocked" | "completed" | "deleted";
    objective: string;
    runCount?: number;
    updatedAt?: string;
    lastRunAt?: string;
  } | null;
  recentSessions: Array<{ id: string; title: string; status?: string }>;
  currentTask?: {
    sessionId: string;
    title: string;
    phase: "thinking" | "tool" | "waiting" | "done" | "failed" | "idle" | "goal" | "paused";
    detail?: string;
  };
}
```

Current V1 also includes:

```ts
floating-ball-update-state // main renderer -> Electron main
floating-ball-command      // Electron main -> main renderer
floating-ball-state        // floating renderer -> Electron main
```

This lets the main window remain the source of truth while the ball stays lightweight.

### Phase 3: Waiting Actions

Add focused IPC actions:

```ts
floating-ball-action:
  "open-session"
  "new-session"
  "stop-current"
  "send-current"
  "open-waiting"
  "continue-current"
  "quick-ask"
  "text-action"
  "open-goal"
  "goal-toggle"
  "waiting-resolve"
```

Low-risk inline actions are available in the helper panel. High-risk approvals should first restore the main window and show the full confirmation context.

## Design Rules

- The ball should answer one question immediately: idle, running, waiting, or failed?
- The first click should return the user to the most relevant context.
- Satellites are for the top few actions only; the panel is for detail.
- Do not make the floating window wider than needed; it should stay a companion, not a second app.
- Do not hide failure/waiting states behind animation. Use clear color, count, and tooltip text.
- Text selection actions should be explicit about what text is being sent to the agent. Clipboard-based V1 is acceptable; fully automatic system selection must be opt-in.

## Recommendation

Build Phase 1 and Phase 2 first. The strongest user-visible win is: minimize while an agent works, see live status, and click once to return to the exact session that needs attention.
