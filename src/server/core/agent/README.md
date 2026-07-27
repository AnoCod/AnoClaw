# Agent Runtime

The agent runtime owns one `AgentLoop` per active session. Permanent employees
remain in `AgentRegistry`; root-scoped collaboration state belongs to the
coordination plane in `src/server/core/coordination/`.

## Execution paths

- User turns call `AgentRuntime.processMessage()`.
- Durable hierarchy and Team tasks are claimed by `CoordinationScheduler` and
  executed by `AgentRuntime.runCoordinationTask()`.
- `Task` action `spawn` creates a durable coordination task and a temporary agent,
  executes it with `isolated`, `summary`, or `fork` context, and always destroys
  the temporary agent after termination.
- Bash and native background processes remain in `BackgroundTaskManager` and
  are exposed as Jobs, not Tasks.

Task completion is committed only after the worker loop yields `Done`. Failure,
timeout, and interruption are persisted as distinct task outcomes. The worker
session transcript and task output remain available after process restart.

## Runtime invariants

- `SessionManager` marks a session `Active` when its loop starts and `Idle` in
  the loop cleanup path.
- A Team session is stable for the tuple
  `rootSessionId + teamId + agentId`.
- The durable mailbox is drained FIFO at safe turn boundaries.
- Every tool invocation carries a `TaskExecutionContext` when it belongs to a
  coordination task.
- Write tools are rejected outside the task write scope or without a matching
  workspace lease.
- DeepSeek-compatible requests keep a `role` on every message and sanitize
  orphaned tool results before each provider call.

See [multi-agent-coordination.md](../../../../docs/multi-agent-coordination.md)
for state machines, persistence, APIs, and recovery rules.
