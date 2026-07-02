# Supervision

Agent interrupt control, heartbeat tracking, timeout detection, and background
task lifecycle management.

## Modules

| Module | Responsibility |
|--------|---------------|
| `InterruptController` | AbortController management, soft/hard interrupts, parent→child cascading |
| `SupervisionManager` | Heartbeat tracking, unresponsive/timeout detection, per-session tool tracking |
| `BackgroundTaskManager` | Unified registry for sub-agent delegations, bash background tasks, and async operations |

---

## InterruptController (Singleton)

Manages `AbortController` instances per session. Handles both hard aborts (stop,
timeout) and soft interrupts (user message queued mid-loop). Cascades interrupts
from parent to child sessions.

### `getInstance(): InterruptController`

### Request / query

- **`requestInterrupt(sessionId, reason): void`** — abort the session's controller
  AND cascade to all linked children (as `ParentStop`). Reasons: `UserStop`,
  `UserSteer`, `ParentStop`, `Timeout`.

- **`requestSteerInterrupt(sessionId): void`** — wake an idle agent session.
  Sets a pending system message, aborts ONLY this session (never cascades).

- **`wakeOnly(sessionId): void`** — abort without cascading and without setting
  a pending message. Caller must set their own pending message before calling.

- **`isInterrupted(sessionId): boolean`** — check if the session's controller is
  aborted.

- **`reason(sessionId): InterruptReason | null`** — get the interrupt reason.

- **`activeCount: number`** — number of active controllers.

### Lifecycle

- **`createController(sessionId): AbortController`** — create a fresh controller
  (replaces any existing one).

- **`removeController(sessionId): void`** — remove controller, reason, parent map,
  and pending message for the session. Also removes parent→child links where the
  session is the parent.

### Session tree linking

- **`linkChild(parentSessionId, childSessionId): void`** — register parent→child
  relationship. When parent is interrupted, the child also gets `ParentStop`.

- **`unlinkChild(childSessionId): void`** — remove the parent→child link.

### Soft interrupt (pending messages)

- **`setPendingUserMessage(sessionId, content): void`** — store a pending message
  for the session. The `AgentLoop` reads this on next `signal.aborted` check and
  injects it into the conversation.

- **`takePendingUserMessage(sessionId): string | null`** — read and clear the
  pending message (one-shot).

- **`hasPendingUserMessage(sessionId): boolean`** — check if a pending message
  exists.

### Interrupt constants

```ts
INTERRUPT_MESSAGE          // '[Request interrupted by user]'
INTERRUPT_MESSAGE_PREFIX   // INTERRUPT_MESSAGE + '\n\n'
INTERRUPT_MESSAGE_FOR_TOOL_USE
```

`INTERRUPT_MESSAGE_PREFIX` is prepended to pending user messages when they are
replayed into the conversation after a soft interrupt.

### Interrupt reasons

| Reason | Trigger | Behavior |
|--------|---------|----------|
| `UserStop` | User clicks Stop | Hard abort, loop ends |
| `UserSteer` | User sends new message mid-loop | Soft — pending message injected, loop continues |
| `ParentStop` | Parent session stopped | Hard abort (child cascaded) |
| `Timeout` | 10-min delegation timeout | Hard abort |

---

## SupervisionManager (Singleton)

Heartbeat tracking and timeout detection for agent sessions. Each agent session
emits a heartbeat on every SSE event, proving it's alive.

### `getInstance(): SupervisionManager`

### Heartbeat

- **`heartbeat(sessionId): void`** — record a heartbeat (current timestamp).

- **`lastHeartbeat(sessionId): Date | null`** — get timestamp of last heartbeat.

- **`secondsSinceLastHeartbeat(sessionId): number`** — seconds elapsed since
  last heartbeat. Returns `Infinity` if never recorded.

- **`isUnresponsive(sessionId): boolean`** — true if heartbeat is past the
  unresponsive threshold (default: from `UNRESPONSIVE_THRESHOLD_SEC` constant).

- **`isTimedOut(sessionId): boolean`** — true if task progress has not been
  updated within the task timeout (default: from `TASK_TIMEOUT_SEC`).

### Progress tracking

- **`taskProgress(sessionId): TaskProgress | undefined`** — get current task
  progress for a session.

- **`updateProgress(sessionId, p: TaskProgress): void`** — update task progress.
  Emits `taskProgressChanged` only if status, attention flag, or heartbeat state
  changed. `TaskProgress`: `{ taskId, agentId, status, attemptCount, summary,
  errorDetail, logSnippet, needsAttention, lastUpdate }`.

### Tool tracking

- **`setCurrentTool(sessionId, tool?): void`** — set or clear the current tool
  name for a session.

- **`getCurrentTool(sessionId): string | undefined`** — get the current tool name.

### Bulk check

- **`checkAllSessions(): void`** — scan all tracked sessions, emit `heartbeatMissed`
  for overdue heartbeats, `agentUnresponsive` for unresponsive sessions, and
  `agentUnresponsive(reason: 'task_timeout')` for timed-out sessions. Typically
  called on a timer.

### Config

- **`setConfig(config): void`** — override heartbeat interval, task timeout,
  unresponsive threshold, max retries.

- **`getConfig(): SupervisionConfig`** — get current config.

### Cleanup

- **`removeSession(sessionId): void`** — remove all tracking data for a session.

- **`trackedSessionCount: number`** — number of sessions being tracked.

---

## BackgroundTaskManager (Singleton)

Unified registry for all background tasks: sub-agent delegations, bash background
commands, and async operations. Single source of truth for the frontend task panel,
desktop notifications, and agent `<task-notification>` injection.

### `getInstance() / resetInstance()`

### Register / update

- **`register(entry): string`** — register a new background task. Returns the
  assigned task ID (format: `bt-{timestamp}-{random}`). Entry fields: `type`
  (`'subagent' | 'bash' | 'command'`), `parentSessionId`, `parentAgentId`,
  `summary`. Status starts as `'running'`.

- **`updateProgress(taskId, data): void`** — update `turnCount` and `currentTool`
  for a running task. Throttled at call site.

### Lifecycle

- **`complete(taskId, result): Promise<BackgroundTaskEntry>`** — mark a task as
  completed. Emits both `EventSubscriptionManager.publish(task:completed:{id})`
  and `TypedEventBus.emit('task:completed', ...)`. The `AgentRuntime` task
  notification subscriber picks this up and injects a `<task-notification>` XML
  message into the parent session.

- **`fail(taskId, error, durationMs): Promise<BackgroundTaskEntry>`** — mark a
  task as failed. Emits both `EventSubscriptionManager` and `TypedEventBus`
  events.

- **`kill(taskId): boolean`** — kill a running task (status → `'killed'`). Returns
  false if task not found or not running.

### Query

- **`getTask(taskId): BackgroundTaskEntry | undefined`** — get a single task.

- **`getActive(): BackgroundTaskEntry[]`** — all active tasks (any status).

- **`getTasksForParent(parentSessionId): BackgroundTaskEntry[]`** — filter by
  parent session. Used by `AgentLoop` to check for pending background work before
  exiting the loop.

- **`hasTask(taskId): boolean`** — existence check.

- **`activeCount: number`** — number of active tasks.

### Event flow

```
BackgroundTaskManager.complete()
  → EventSubscriptionManager.publish('task:completed:{id}')
  → TypedEventBus.emit('task:completed', payload)
    → AgentRuntime._subscribeToTaskNotifications() handler
      → buildTaskNotificationXML() → appendMessage() → requestSteerInterrupt()
```

---

## Integration Points

### With AgentRuntime

```
processMessage()
  ├── InterruptController.createController(sessionId)   // setup
  ├── SupervisionManager.heartbeat(sessionId)            // before loop
  ├── AgentLoop.run()
  │     └── SupervisionManager.heartbeat(sessionId)      // every event
  └── InterruptController.removeController(sessionId)     // cleanup

delegateTask()
  ├── InterruptController.linkChild(parent, child)       // tree setup
  ├── BackgroundTaskManager.register(...)                // tracking
  └── [sub-agent loop in background]
      ├── InterruptController.unlinkChild(child)         // cleanup
      └── BackgroundTaskManager.complete/fail(...)       // notification
```

### With Gateway / Infra

```
SendMessageHandler / StopHandler
  → InterruptController.requestInterrupt() / setPendingUserMessage()

SessionMessageRoute / SessionControlRoutes
  → InterruptController.requestInterrupt()

BackgroundTaskRoute
  → BackgroundTaskManager.getActive() / getTask()
```

---

## Dependencies

### Called by
- **Core**: `AgentRuntime`, `AgentLoop`, `AgentDelegation`
- **Gateway**: `SessionMessageRoute`, `SessionControlRoutes`, `BackgroundTaskRoute`
- **Infra**: `SendMessageHandler`, `StopHandler`

### Depends on
- **Events**: `TypedEventBus`, `EventSubscriptionManager`
- **Constants**: `HEARTBEAT_INTERVAL_SEC`, `TASK_TIMEOUT_SEC`, `UNRESPONSIVE_THRESHOLD_SEC`
- **Logger**: `createLogger`

---

## Usage Example

```ts
import { InterruptController, InterruptReason } from './supervision/InterruptController.js';
import { SupervisionManager } from './supervision/SupervisionManager.js';
import { BackgroundTaskManager } from './supervision/BackgroundTaskManager.js';

// 1. Set up interrupt for a session
const ic = InterruptController.getInstance();
const signal = ic.createController('session-1').signal;

// 2. Link parent→child for cascading interrupts
ic.linkChild('session-1', 'session-1-manager-research');

// 3. Soft interrupt — inject a new user message mid-loop
ic.setPendingUserMessage('session-1', 'Stop what you are doing and answer this instead.');
ic.requestSteerInterrupt('session-1');

// 4. Hard interrupt — cascades to children
ic.requestInterrupt('session-1', InterruptReason.UserStop);

// 5. Track a background task
const bgm = BackgroundTaskManager.getInstance();
const taskId = bgm.register({
  type: 'subagent',
  parentSessionId: 'session-1',
  parentAgentId: 'main-agent',
  summary: 'Research market competitors',
});

// Update progress periodically
bgm.updateProgress(taskId, { turnCount: 5, currentTool: 'WebFetch' });

// Complete with result
await bgm.complete(taskId, {
  content: 'Found 3 major competitors...',
  turnCount: 12,
  durationMs: 45000,
});

// 6. Check supervision status
const sm = SupervisionManager.getInstance();
sm.heartbeat('session-1');
if (sm.isUnresponsive('session-1')) {
  console.log(`Last heartbeat: ${sm.secondsSinceLastHeartbeat('session-1')}s ago`);
}
```

---

## Key Constraints

1. **Interrupt cascading**: `requestInterrupt()` on a parent propagates `ParentStop`
   to all linked children. `requestSteerInterrupt()` does NOT cascade — it's
   session-local only.
2. **Soft vs hard**: `UserSteer` is soft — the `AgentLoop` reads the pending
   message, injects it, and continues. All other reasons are hard — the loop
   breaks.
3. **Background task notification**: Completed/failed tasks trigger automatic
   message injection into the parent session via `buildTaskNotificationXML()`.
   If the parent session is idle, a new `AgentLoop` is started to process the
   notification.
4. **Heartbeat rate**: Heartbeats are emitted on every SSE event from the
   `AgentLoop`. If no events for > `UNRESPONSIVE_THRESHOLD_SEC`, the session is
   flagged unresponsive.
5. **Task timeout**: Default 10 minutes. Exceeded → `InterruptController.requestInterrupt(Timeout)`.
