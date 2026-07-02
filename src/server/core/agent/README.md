# Agent Subsystem

ReAct-loop execution engine, agent lifecycle registry, inter-agent communication,
parallel task orchestration, and supervision. Entry point for all agent message
processing.

## Modules

| Module | Responsibility |
|--------|---------------|
| `AgentLoop` | ReAct loop — LLM call → tool execution → next turn |
| `AgentLoopLLM` | LLM API call with retry, streaming, orphaned-message cleanup |
| `AgentRuntime` | Singleton entry point — creates AgentLoop, delegates tasks |
| `Agent` | Agent identity — role, state, model config, per-session status |
| `AgentRegistry` | Singleton registry — CRUD, org tree, persistence |
| `AgentDelegation` | Sub-agent spawn + task delegation helpers |
| `AgentChannel` | Real-time typed messaging between agents via TypedEventBus |
| `SharedContextStore` | Bidirectional key-value shared state per team/session |
| `TaskDAG` | Dependency graph for parallel task orchestration |
| `ExecutionPlan` | Batch-parallel execution of TaskDAG plans |
| `StallDetector` | Circuit-breaker stall detection with escalating recovery |
| `AgentConfig` | Config load/save, API key encryption |
| `TaskNotification` | Task notification XML construction |

---

## AgentLoop

ReAct loop execution engine. Each instance is bound to a single `(agentId, sessionId)` pair.

### Constructor

```ts
new AgentLoop(config: AgentLoopConfig)
```

`AgentLoopConfig`:
| Field | Type | Default |
|-------|------|---------|
| `agentId` | `string` | required |
| `sessionId` | `string` | required |
| `maxTurns` | `number` | `MAX_TURNS_DEFAULT` |
| `temperature` | `number` | agent config |
| `contextWindow` | `number` | agent config |

### `run(userMessage, history, signal?): AsyncGenerator<SSEEvent>`

Core ReAct loop. Yields SSE events (`think` / `text` / `tool_call` / `tool_result` /
`done` / `error` / `status_info` / `sleep` / `wake`).

```ts
const loop = new AgentLoop({ agentId, sessionId, maxTurns: 25, temperature: 0.7, contextWindow: 1048576 });
for await (const event of loop.run(userMessage, history, signal)) {
  // forward event to frontend
}
```

### Key behaviors

- **Compaction**: triggers when token usage > 70% of context window (every 8 turns)
- **Inter-turn message injection**: AgentChannel (real-time) + JSONL polling (fallback)
- **Stall detection**: 3-level escalation — hint → compact → yield
- **Keyword extraction**: emits `loop:keyword_turn` event every 10 turns
- **Background task wait**: polls for pending tasks instead of exiting loop
- **Infinite mode**: keeps the agent alive after completion, sleeps until new messages
- **Extension point**: `agentLoop` plugin override can replace the entire ReAct loop

---

## AgentLoopLLM

LLM API call with exponential-backoff retry, streaming, and message assembly.
Extracted from `AgentLoop.ts`.

### `sanitizeOrphanedMessages(messages): SanitizableMsg[]`

**Critical constraint (DeepSeek)**: Removes tool-result messages whose `tool_call_id`
has no matching `tool_call` in any assistant message, and strips orphaned
`tool_calls` from assistant messages that have no corresponding tool results.
DeepSeek and compatible APIs reject messages where a `tool` role message doesn't
follow an `assistant` message with the matching `tool_call`.

### `callLLMWithRetry(config, messages, systemPrompt, tools, signal): AsyncGenerator<SSEEvent, LLMCallResult>`

| Config field | Description |
|-------------|-------------|
| `agentId` / `sessionId` | Identity |
| `modelName` / `provider` | LLM selection |
| `apiUrl` / `apiKey` | Provider endpoint |
| `agentContextWindow` | Agent's max context |
| `temperature` | Sampling temp |
| `contextWindow` | Session context window |
| `turn` | Current turn number |
| `postWait` | If true, skip retries |

**Retry strategy**: exponential backoff (1s, 2s, 4s, 8s, max 60s), max retries from
`MAX_API_RETRIES`. 413 errors trigger compaction before retry. Timeout errors
trigger shorter compaction. Unretryable errors (400, 401, 402, 403) fail immediately.

**Returns** `LLMCallResult`: `{ assistantMessage, hadThinkContent, fatalError, errorMessage }`.

---

## StallDetector

Circuit-breaker stall detection with escalating recovery.

### `record(toolNames, results): void`

Record this turn's tool call activity. Tracks tool count, failure status, and
the last tool name used.

### `recordEmptyResponse(): void`

Record that the LLM returned empty content (no text, no tools).

### `check(): StallResult`

Check whether the agent is stalled. Returns `{ stalled, action?, message? }`.

**Detection rules**:
1. ≥3 consecutive empty LLM responses → stalled
2. N consecutive turns with no tool calls → stalled
3. N consecutive same-tool failures → dead loop
4. ≥3 turns in last 10 with >50 tool calls each → excessive tooling

**Escalation levels**:
| Level | Action | Behavior |
|-------|--------|----------|
| 1 | `hint` | Inject system message guiding the agent |
| 2 | `compact` | Compress context to force reorientation |
| 3 | `yield` | Give up, report stall to upper layer |

### `reset(): void`

Reset all counters and escalation level (called after compaction or successful
recovery).

---

## AgentRuntime (Singleton)

Entry point for processing messages, delegating tasks, and spawning sub-agents.
Extends `EventEmitter`.

### `getInstance() / resetInstance()`

Standard singleton pattern.

### `processMessage(sessionId, agentId, message, history): AsyncGenerator<SSEEvent>`

Main entry point. Creates an `AgentLoop`, runs it, yields SSE events.

Lifecycle:
1. Resolve agent from registry
2. Guard against concurrent same-session loops (queues as soft interrupt)
3. Acquire `SessionLeaseManager` lease
4. Create `InterruptController` for the session
5. Build `AgentLoopConfig` from agent settings
6. Run `AgentLoop.run()`, forwarding events
7. On completion: `AgentLoopCompleted` event, memory lifecycle, infinite mode sleep/wake
8. On error: emits `AgentLoopCompleted(status: 'error')`
9. Finally: cleanup loop, interrupt controller, session status, lease

### `delegateTask(targetAgentId, task, parentSessionId, parentAgentId): Promise<ToolResult>`

Delegate a task to a subordinate agent in the org tree.
- Role check: only MainAgent(0) and Manager(1) can delegate
- Org-tree validation: target must be a direct child of the delegator
- Creates a sub-session, enriches task with parent context
- Runs the sub-agent loop in background (non-blocking)
- Registers with `BackgroundTaskManager`
- Timeout: 10 minutes → `InterruptController.requestInterrupt()`

Returns immediately — the parent agent continues working.

### `spawnSubAgent(config, callerAgentId?, parentSessionId?): Promise<ToolResult>`

Create a temporary `SubAgent`, run a task synchronously, destroy the agent.
- Role check: Member(2)+ can spawn
- Inherits provider/api/model from caller
- Tool whitelist based on `subagent_type`:
  - `Explore`: Read, Glob, Grep, WebFetch, WebSearch
  - `Plan`: Read, Glob, Grep, EnterPlanMode, TodoWrite
  - `general-purpose`: Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite
- If `config.persist` is true, creates a persistent disk-only sub-session

### `executeParallelPlan(tasks, parentSessionId, parentAgentId): Promise<string>`

Execute multiple delegated tasks in dependency-ordered parallel batches.
Builds a `TaskDAG` and runs via `ExecutionPlan`.

### `isSessionActive(sessionId): boolean`

Check if a session has an active `AgentLoop` running.

### `cleanupSession(sessionId): void`

Manually remove a stuck/broken `AgentLoop`.

### `activeSessionCount: number`

Number of currently active sessions.

---

## Agent

Agent identity instance. Extends `EventEmitter`. One `Agent` can serve multiple sessions.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Immutable unique ID |
| `name` | `string` | Mutable display name (emits `NameChanged`) |
| `role` | `AgentRole` | `MainAgent` / `Manager` / `Member` / `SubAgent` |
| `level` | `number` | Org level (0–3) |
| `parentAgentId` | `string \| null` | Parent in org tree |
| `teamName` | `string` | Team identifier |
| `createdAt` | `string` | ISO timestamp |
| `state` | `AgentState` | `Active` / `Destroyed` |
| `isActive` | `boolean` | Shorthand for `state === Active` |
| `servingSessionCount` | `number` | Active session count |

### Model properties

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `string` | LLM provider name |
| `apiUrl` | `string` | Provider endpoint URL |
| `apiKey` | `string` | Decrypted API key |
| `modelName` | `string` | Model identifier |
| `contextWindow` | `number` | Max context tokens |
| `maxTurns` | `number` | Max turns per loop |
| `temperature` | `number` | Sampling temperature |

### Methods

- **`allowedTools(): string[]`** — list of allowed tool names
- **`isManagerRole(): boolean`** — is MainAgent or Manager
- **`sessionStatus(sessionId): AgentStatus`** — per-session status (`idle`/`running`/`error`)
- **`setSessionStatus(sessionId, status): void`** — update per-session status
- **`clearSessionStatus(sessionId): void`** — remove session tracking
- **`adjustSessionCount(delta): void`** — increment/decrement session count
- **`reassignParent(newParentId, newLevel): void`** — move in org tree
- **`updateFromConfig(config): void`** — batch update from config object
- **`toConfig(): AgentConfigWithKey`** — serialize for disk persistence

---

## AgentRegistry (Singleton)

Registry for all Agent instances. Extends `EventEmitter`.

### `getInstance() / resetInstance()`

Standard singleton pattern.

### CRUD

- **`registerAgent(agent: Agent): void`** — register or replace an agent
- **`unregisterAgent(agentId: string): boolean`** — unregister by ID
- **`agent(agentId: string): Agent | undefined`** — get by exact ID
- **`findAgent(idOrName: string): Agent | undefined`** — get by ID first, then case-insensitive name
- **`allAgents(): Agent[]`** — all registered agents
- **`activeAgents(): Agent[]`** — non-destroyed agents
- **`size: number`** — count of registered agents
- **`hasAgent(agentId: string): boolean`** — existence check

### Query

- **`agentsByParent(parentAgentId): Agent[]`** — direct children
- **`agentsByRole(role): Agent[]`** — filter by role
- **`mainAgent(): Agent | undefined`** — the MainAgent (CEO)

### Org tree

- **`buildOrgTree(): OrgNode | null`** — full org tree from MainAgent
- **`reportChain(agentId): string[]`** — chain up to CEO
- **`isManager(agentId): boolean`** — has direct reports
- **`orgRole(agentId): OrgRole`** — `Manager` or `Member`

### Persistence

- **`loadFromDirectory(dirPath?): Promise<void>`** — load `data/agents/*.json`
- **`saveAgent(agentId): Promise<void>`** — save to `data/agents/{id}.json`

---

## AgentDelegation

Sub-agent spawn and task delegation helpers. All functions take `AgentRuntime` as
first parameter.

### `delegateTask()` — see `AgentRuntime.delegateTask()`

### `createSubSession()` — see `SessionManager.createSubSession()`

### `subAgentAllowedTools(runtime, subagentType): string[]`

Map sub-agent type to tool whitelist.

### `bubbleEventToParent(runtime, parentSessionId, subSessionId, subAgentId, event): void`

Forward a sub-agent SSE event to parent via `TypedEventBus`.

### `emitDelegationStatus(runtime, parentSessionId, subSessionId, subAgentId, payload): void`

Emit delegation lifecycle events: `started` / `working` / `tool_executing` /
`completed` / `error`.

### `handleSubAgentOutput(runtime, eventStream, parentSessionId, subSessionId, subAgentId, taskSummary, startedAt, persister, state): Promise<void>`

Process the SSE stream from a delegated sub-agent. Handles per-event persistence,
progress bubbling, and WebSocket forwarding to both parent and sub-session.

### `spawnSubAgent(runtime, config, callerAgentId?, parentSessionId?): Promise<ToolResult>` — see `AgentRuntime.spawnSubAgent()`

---

## AgentChannel (Singleton)

Real-time typed messaging between agents via `TypedEventBus`.

### `getInstance(): AgentChannel`

### `send(targetAgentId, targetSessionId, sourceAgentId, sourceSessionId, content, role?): void`

Send a message to another agent's session. Delivered via `TypedEventBus` event
`agent:message`.

### `subscribe(agentId, sessionId, handler): () => void`

Subscribe to messages addressed to a specific `(agentId, sessionId)` pair.
Returns an unsubscribe function.

AgentLoop subscribes automatically during `run()`. Messages arrive on the next
inter-turn check (sub-millisecond, no polling delay).

---

## SharedContextStore (Singleton)

Bidirectional key-value shared state between agents in the same team.

### `getInstance(): SharedContextStore`

### `set(scope, key, value, agentId): void`

Write a value. Scoped by team name or session ID. Auto-evicts oldest entry when
over 500 entries per scope.

### `get(scope, key): ContextEntry | null`

Read a single value.

### `getAll(scope): ContextEntry[]`

Get all entries in a scope, sorted oldest-first.

### `getSince(scope, since): ContextEntry[]`

Get entries written after a specific timestamp.

### `clearScope(scope): void`

Remove all entries for a scope (cleanup on session end).

### `size(scope): number`

Number of entries in a scope.

---

## TaskDAG

Directed Acyclic Graph for dependency-ordered parallel task orchestration.

### `addTask(task: TaskNode): void`

Add a task node. `TaskNode`: `{ id, agentId, description, dependsOn, status, result?, startedAt?, completedAt? }`.

### `getReadyTasks(): TaskNode[]`

Return tasks where all dependencies are `completed` and the task is `pending`.

### `isComplete(): boolean`

True when all tasks are in a terminal state (`completed` or `failed`).

### `summary(): string`

Human-readable status: `"Tasks: 3 completed, 1 failed, 0 running, 2 pending"`.

---

## ExecutionPlan

Executes a `TaskDAG` in dependency-ordered parallel batches.

### Constructor

```ts
new ExecutionPlan(dag: TaskDAG, registry: AgentRegistry)
```

### `execute(parentSessionId, parentAgentId): Promise<Map<string, string>>`

Run the full plan:
1. Get ready tasks from DAG
2. Run batch in parallel via `AgentRuntime.delegateTask()`
3. Wait for all to complete
4. Detect orphaned tasks (dependencies failed/missing)
5. Repeat until complete or timeout (10 min)

Returns `Map<taskId, resultString>`.

---

## Agent Hierarchy

```
MainAgent (CEO, level 0) → Manager (level 1) → Member (level 2) → SubAgent (temp, level 3)
```

### Permission model

| Role | Level | Permissions |
|------|-------|-------------|
| MainAgent | 0 | All tools + `HireEmployee`, `UpdateOrg`, `TaskAssign` |
| Manager | 1 | `HireEmployee`, `UpdateOrg`, `TaskAssign` |
| Member | 2 | `SubAgentSpawn` |
| SubAgent | 3 | All other tools (limited) |

Delegation target must be a **direct child** in the org tree. Timeout: 10 min.

---

## Dependencies

### Called by
- **Gateway**: `AgentExecuteRoute`, `SessionMessageRoute`, `SessionControlRoutes`,
  `AgentControlRoutes`, `AgentOrgTreeRoute`, `AgentHandlers`, `SessionHandlers`,
  `SystemHandlers`, `GatewayRouter`, `InlineSuggestHandler`, `SystemInfoRoute`,
  `ToolsDetailRoute`, `BackgroundTaskRoute`
- **Infra**: `SendMessageHandler`, `StopHandler`

### Depends on
- **Session**: `SessionManager`, `SessionStore`, `SessionLeaseManager`
- **Tools**: `ToolRegistry`
- **Prompt**: `PromptAssembler`
- **Context**: `TokenCounter`, `compactAndRebuildMessages`
- **Events**: `TypedEventBus`, `EventSubscriptionManager`
- **Infra**: `createLLMProvider`, `APIScheduler`, `WsServer`, `JsonlStore`, `StreamPersister`, `StreamConsumer`
- **Plugin**: `ExtensionPoints`
- **Settings**: `SettingsManager`
- **Constants**: `MAX_TURNS_DEFAULT`, `COMPRESSION_TRIGGER_RATIO`, etc.

---

## Usage Example

```ts
import { AgentRuntime } from './core/agent/AgentRuntime.js';
import { AgentRegistry } from './core/agent/AgentRegistry.js';
import { SessionManager } from './core/session/SessionManager.js';
import { AgentChannel } from './core/agent/AgentChannel.js';

// 1. Initialize
const registry = AgentRegistry.getInstance();
await registry.loadFromDirectory();

// 2. Create session
const sm = SessionManager.getInstance();
const session = await sm.createMainSession('main-agent', 'My Session');

// 3. Process a user message
const runtime = AgentRuntime.getInstance();
const message: Message = {
  id: 'msg-1',
  sessionId: session.id,
  role: 'user',
  content: 'Write a test script',
  tokenCount: 5,
  compressed: false,
  timestamp: new Date().toISOString(),
};

for await (const event of runtime.processMessage(session.id, 'main-agent', message, [])) {
  // Forward SSE events to frontend
  console.log(event.type, event);
}

// 4. Delegate a task to a subordinate manager
const result = await runtime.delegateTask(
  'manager-research',           // target agent
  'Research market competitors', // task description
  session.id,                   // parent session
  'main-agent',                 // parent agent
);

// 5. Send a message to another agent via AgentChannel
const channel = AgentChannel.getInstance();
channel.send(
  'manager-research',           // target agent
  'session-abc',                // target session
  'main-agent',                 // source agent
  session.id,                   // source session
  'Please update your findings', // content
  'user',                       // role
);

// 6. Execute parallel tasks with dependencies
const summary = await runtime.executeParallelPlan([
  { agentId: 'manager-research', description: 'Research phase', dependsOn: [] },
  { agentId: 'manager-dev', description: 'Development phase', dependsOn: ['0'] },
], session.id, 'main-agent');
```

---

## Key Constraints

1. **DeepSeek role requirements**: All messages must have `role` — tool results
   included. `sanitizeOrphanedMessages()` must run before every API call.
2. **One AgentLoop per session**: `_activeLoops` map enforces this. Concurrent
   messages queue as soft interrupts.
3. **Sub-agent timeout**: 10 minutes hard limit, enforced by `InterruptController`.
4. **Org-tree validation**: delegation only to direct children. Re-delegation
   (grandchild) is rejected.
5. **Agent channel**: no polling — delivery via `TypedEventBus` is sub-millisecond.
6. **Shared context**: in-memory only, survives for session lifetime, max 500
   entries per scope.
