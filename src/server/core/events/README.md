# Events System

Centralized publish/subscribe event infrastructure for core domain events. Two buses serve different needs: `TypedEventBus` for fire-and-forget system events, and `EventSubscriptionManager` for targeted agent notification with session persistence.

## Public API

### TypedEventBus (Singleton)

```ts
import { TypedEventBus } from './TypedEventBus.js';

// Emit a typed event
TypedEventBus.emit('tool:execution_completed', {
  sessionId: '...',
  toolName: 'Read',
  success: true,
  durationMs: 45,
});

// Subscribe to a specific event
const unsub = TypedEventBus.on('session:created', (payload) => {
  console.log('New session:', payload.sessionId);
});
// Later: unsub();

// Subscribe to ALL events (debugging, plugin forwarding)
const unsubAll = TypedEventBus.onAny((event, payload) => {
  console.log(`[${event}]`, payload);
});
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `emit(event, payload)` | `event: K` (typed) or `event: string`, `payload: T` | `void` | Emit to all specific + wildcard handlers. Handler errors are caught and logged. |
| `on(event, handler)` | `event: K` or `event: string`, `handler: (payload) => void` | `() => void` | Subscribe. Returns unsubscribe function. |
| `onAny(handler)` | `handler: (event: string, payload: unknown) => void` | `() => void` | Wildcard subscription — receives all events. |
| `handlerCount` | — | `number` | Total specific handlers registered |
| `anyHandlerCount` | — | `number` | Total wildcard handlers registered |

**Thread safety**: Node.js is single-threaded (event loop). No locks needed. Handler errors are caught and logged — one bad subscriber cannot break the bus.

### EventSubscriptionManager (Singleton)

```ts
import { EventSubscriptionManager } from './EventSubscriptionManager.js';
const esm = EventSubscriptionManager.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `subscribe(sessionId, agentId, topic, options?)` | `sessionId: string`, `agentId: string`, `topic: string`, `options?: { oneShot?: boolean }` | `string` (subscription ID) | Subscribe a session+agent to a topic |
| `unsubscribe(subscriptionId)` | `subscriptionId: string` | `boolean` | Remove by subscription ID |
| `unsubscribe(sessionId, topic)` | `sessionId: string`, `topic: string` | `boolean` | Remove all subs for session+topic |
| `unsubscribeAll(sessionId)` | `sessionId: string` | `number` | Remove all subs for a session |
| `publish(topic, payload)` | `topic: string`, `payload: unknown` | `Promise<number>` | Deliver event to all subscribers. Writes system message to each session + soft interrupt. |
| `hasSubscription(sessionId, topic)` | `sessionId: string`, `topic: string` | `boolean` | Check subscription existence |
| `getSubscriptions(sessionId)` | `sessionId: string` | `Subscription[]` | List all subs for a session |
| `activeCount` | — | `number` | Total registered subscriptions |
| `topicCount` | — | `number` | Distinct topics with subscribers |

### Subscription Interface

```ts
interface Subscription {
  id: string;           // Unique ID (format: sub-{counter}-{random})
  sessionId: string;    // Target session
  agentId: string;      // Target agent
  topic: string;        // Exact topic string
  oneShot: boolean;     // Auto-unsubscribe after first delivery
  createdAt: number;   // Timestamp
}
```

## Topic Convention

Topics use colon-delimited namespacing:

| Pattern | Examples |
|---------|----------|
| `agent:message:<id>` | `agent:message:agent-abc123` |
| `session:*` | `session:created`, `session:archiving` |
| `tool:*` | `tool:execution_started`, `tool:execution_completed` |
| `loop:*` | `loop:completed`, `loop:compaction_triggered`, `loop:keyword_turn` |
| `task:*` | `task:completed:<subSessionId>` |
| `delegation:*` | `delegation:started`, `delegation:working`, `delegation:completed`, `delegation:error` |
| `agent:*` | `agent:status_changed`, `agent:registered` |
| `llm:*` | `llm:token_usage` |
| `memory:*` | `memory:saved` |
| `plugin:*` | `plugin:load_failed` |
| `subscription:*` | `subscription:delivered` |
| `process:*` | `process:ready:<pid>` |

**V1**: Exact topic match only. No wildcard/glob support in `EventSubscriptionManager`.

## How EventSubscriptionManager Delivers Events

`publish(topic, payload)` does three things per subscriber:

1. **Writes** a system message `[Event: topic] payload` to the subscriber's session via `SessionManager.appendMessage()` — persisted in JSONL
2. **Triggers** a soft interrupt via `InterruptController.wakeOnly()` — agent sees it immediately
3. **OneShot cleanup** — if `oneShot: true`, auto-unsubscribes after delivery

## Typical TypedEventBus Events

These are fire-and-forget system events (not targeted at specific sessions):

- `tool:execution_completed` → StatsCollector records usage, PatternDetector buffers sequence
- `loop:completed` → SessionTagger auto-tags, tool buffer flushed
- `loop:compaction_triggered` → audit/monitoring
- `loop:keyword_turn` → KeywordExtractor runs
- `session:created` → WsForwardSubscriber notifies frontend
- `session:archiving` → EventSubscriptionManager cleans up all subs for that session
- `agent:status_changed` → frontend updates
- `memory:saved` → cache invalidation
- `delegation:*` → BackgroundTaskManager tracks progress
- `plugin:load_failed` → toast notification to frontend via WebSocket
- `subscription:delivered` → monitoring

## Dependencies

### Called by
- **Every core service** — `AgentLoop`, `AgentRuntime`, `MemoryManager`, `SessionManager`, `PluginHostManager`, `ContextCompressor`, `EvolutionExtension`, `InterruptController`, `BackgroundTaskManager`, `WsForwardSubscriber`
- `PluginHostManager` — installs `onAny()` for kernel→plugin event forwarding

### Depends on
- `SessionManager` — EventSubscriptionManager writes events to sessions
- `InterruptController` — soft interrupt on event delivery
- `TypedEventBus` — EventSubscriptionManager emits `subscription:delivered`

## Two Buses, Two Purposes

| | TypedEventBus | EventSubscriptionManager |
|---|---|---|
| **Pattern** | Fire-and-forget broadcast | Targeted delivery |
| **Subscribers** | In-process handlers | Sessions + agents |
| **Persistence** | None (in-memory only) | Events written to session JSONL |
| **Typed** | Yes (CoreEventMap) | No (string topics) |
| **Wildcard** | Yes (`onAny`) | No (exact match only) |
| **Use case** | System monitoring, stats, plugin forwarding | Agent notification, task completion, cross-agent messaging |

## Constraints

- `TypedEventBus` is thread-safe by virtue of Node.js single-threaded event loop
- Handler errors are caught and logged — the bus never crashes from a bad subscriber
- `EventSubscriptionManager` matches topics exactly — no wildcards (V1)
- `EventSubscriptionManager` cleans up all subscriptions when session is archived
- `TypedEventBus.resetInstance()` is for testing only — clears all handlers
