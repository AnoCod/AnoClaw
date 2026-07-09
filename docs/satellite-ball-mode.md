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
   - FloatingBall state 包含 `waitingInbox`，提供 sessionId、标题、风险等级和参数摘要。
   - 小面板在等待时显示 “Needs attention” 卡片，点击后恢复主窗口并打开对应会话。
   - 这里只做定位和上下文展示，不在小窗内直接批准高风险工具，避免误触。

   后续增强：
   - AskUserQuestion 等待项接入同一个 inbox。
   - 对明确低风险确认增加小窗内批准/拒绝。
   - 恢复主窗口后滚动到具体确认卡片。

2. Background Task Radar

   长时间 build/test/search/package/run server 时，最小化后仍能看到运行状态。球体外圈转动表示有任务在跑；任务失败时变红，并保留最近失败摘要。

3. Goal Pulse

   goal 模式下，球体显示 goal 状态：
   - active: 外圈缓慢呼吸。
   - sleeping: 小月牙/暂停样式。
   - blocked: amber + 等待数量。
   - complete: green/blue 短闪，然后回到 idle。

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
  waitingInbox?: {
    count: number;
    sessionId: string | null;
    title: string;
    detail?: string;
    riskLevel?: string;
  };
  recentSessions: Array<{ id: string; title: string; status?: string }>;
  currentTask?: {
    sessionId: string;
    title: string;
    phase: "thinking" | "tool" | "waiting" | "done" | "failed";
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
```

Low-risk inline actions can come later. High-risk approvals should first restore the main window and show the full confirmation context.

## Design Rules

- The ball should answer one question immediately: idle, running, waiting, or failed?
- The first click should return the user to the most relevant context.
- Satellites are for the top few actions only; the panel is for detail.
- Do not make the floating window wider than needed; it should stay a companion, not a second app.
- Do not hide failure/waiting states behind animation. Use clear color, count, and tooltip text.
- Text selection actions should be explicit about what text is being sent to the agent. Clipboard-based V1 is acceptable; fully automatic system selection must be opt-in.

## Recommendation

Build Phase 1 and Phase 2 first. The strongest user-visible win is: minimize while an agent works, see live status, and click once to return to the exact session that needs attention.
