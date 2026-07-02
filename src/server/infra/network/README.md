# src/server/infra/network — Network Layer

## Overview

WebSocket server, message routing, HTTP client, and WebFetch utilities. The WebSocket layer uses a single persistent connection (not per-session) with per-session event buffering and a pluggable typed message dispatch system. An event-bus-to-WS bridge forwards ~20 domain events to the frontend.

## Public Interface

### WsServer (Singleton)

Single persistent WebSocket connection. Implements `Transport`.

```ts
class WsServer extends EventEmitter implements Transport {
  static getInstance(): WsServer;

  // Bind to an HTTP server (path: /ws)
  attach(server: http.Server): void;

  // Send a tagged event to a session (buffers if disconnected)
  send(sessionId: string, data: Record<string, unknown>): boolean;

  // Broadcast to all connected sessions
  broadcast(data: Record<string, unknown>): void;

  // Check connection state
  isConnected(sessionId?: string): boolean;
  activeSessions(): string[];
  connectionCount: number;  // getter

  // Clear buffered events for a session
  clearEventBuffer(sessionId: string): void;

  // Graceful shutdown
  shutdown(): Promise<void>;

  readonly serverEpoch: number;  // Server start timestamp
}
```

**Constants:** `MAX_BUFFERED_EVENTS = 300`, `HEARTBEAT_INTERVAL_MS = 15000`.

**Events:** `clientConnected`, `clientDisconnected`, `message(sessionId, msg)`.

**Connection lifecycle:**
1. Client connects to `/ws`
2. Previous connection closed (single-tab enforcement)
3. Server sends `{ type: 'serverEpoch', epoch }`
4. Buffered events flushed to new client
5. 15s heartbeat pings; failed pong → disconnect

---

### WsMessageRouter

Pluggable typed message dispatch. Multiple handlers per type.

```ts
interface WsMessageContext {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  ws: Transport;
}

type WsMessageHandler = (ctx: WsMessageContext) => Promise<void> | void;

class WsMessageRouter {
  on(type: string, handler: WsMessageHandler): void;
  dispatch(ctx: WsMessageContext): Promise<void>;
  clear(): void;
}
```

---

### WS Message Handlers

Registered via `registerAllWsHandlers(router)`.

| Message Type | Handler | Description |
|-------------|---------|-------------|
| `send_message` | SendMessageHandler | User message → agent execution, session auto-creation, history loading, SSE streaming |
| `stop` | StopHandler | Interrupt agent via `InterruptController` |
| `ping` | PingHandler | Heartbeat → `{ type: 'pong' }` |
| `run_command` | RunCommandHandler | Execute slash command |
| `set_running_mode` | SetRunningModeHandler | Set `normal` or `infinite` mode on session |
| `quality_score` | QualityScoreHandler | Persist 1–5 rating to `EvolutionManager` |
| `editor_context` | EditorContextHandler | Store editor state (open files, cursor, selection) on session metadata |

---

### WsForwardSubscriber

Bridges `TypedEventBus` → WebSocket. Runs once at startup.

```ts
function installWsForwarding(): void;
```

**Forwards ~20 event types:** `session:created`, `message_appended`, `workspace_changed`, `agent:status_changed`, `tool:execution_started/completed`, `loop:completed`, `compaction_triggered`, `delegation:*`, `task:*`, etc.

**Routing rules:**
- Session/tool/loop events → resolved to root session
- Delegation/task events → sent to direct parent session only

---

### HttpClient

Fetch-based HTTP client with retry, timeout, SSE streaming.

```ts
interface RequestOptions {
  timeout?: number;     // default 30000
  retries?: number;     // default 3
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface StreamOptions extends RequestOptions {
  onChunk?: (chunk: string) => void;
}

class HttpClient extends EventEmitter {
  constructor(baseUrl?: string);

  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  stream(path: string, body: unknown, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;

  setDefaultHeaders(headers: Record<string, string>): void;
  setAuthToken(token: string): void;
  setBaseUrl(url: string): void;
}
```

**Retry logic:** exponential backoff (500ms base, 30s cap), jitter. Retryable statuses: 408, 429, 500, 502, 503, 504. Never retries on AbortError or non-retryable 4xx.

**Events:** `response`, `retry`, `streamError`.

---

### WebFetchHelper

Clean browser User-Agent fetch for web-facing tools.

```ts
function webFetch(url: string, opts?: FetchOptions): Promise<Response>;

interface FetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}
```

Spoofs Chrome 125 User-Agent. Supports `HTTPS_PROXY`/`HTTP_PROXY` env vars via Node.js global fetch.

---

### Transport (Interface)

Abstract transport contract for event delivery.

```ts
interface Transport {
  send(sessionId: string, event: Record<string, unknown>): boolean;
  broadcast(event: Record<string, unknown>): void;
  isConnected(sessionId?: string): boolean;
  activeSessions(): string[];
  shutdown(): Promise<void>;
  on(event: 'clientConnected' | 'clientDisconnected', handler: () => void): void;
  clearEventBuffer?(sessionId: string): void;
}
```

---

## Dependencies

```
WsServer          → events, ws (npm), http (types)
WsMessageRouter   → Transport (type only)
WsForwardSubscriber → TypedEventBus, WsServer, SessionManager
HttpClient        → events
WebFetchHelper    → LogManager
Handlers          → WsMessageRouter, SessionManager, AgentRuntime, AgentRegistry,
                    InterruptController, EvolutionManager, CommandRegistry, etc.
```

## Usage

```ts
import { WsServer } from './infra/network/WsServer.js';
import { WsMessageRouter } from './infra/network/WsMessageRouter.js';
import { registerAllWsHandlers } from './infra/network/handlers/registerAllHandlers.js';

// Attach WS to HTTP server
const ws = WsServer.getInstance();
ws.attach(httpServer);

// Set up message routing
const router = new WsMessageRouter();
registerAllWsHandlers(router);

// Subscribe to incoming messages
ws.on('message', (sessionId, msg) => {
  router.dispatch({ sessionId, type: msg.type, data: msg, ws });
});

// Send event to a session
ws.send(sessionId, { type: 'text_delta', content: 'Hello', seq: 1 });
```
