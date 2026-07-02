# src/public/ts — Frontend Architecture

## Overview

Zero-framework frontend (pure TypeScript + native DOM) with a single global WebSocket connection, per-session streaming event processing, and a plugin extension system for UI component and tool card overrides.

## Architecture Layers

```
┌─────────────────────────────────────────┐
│  Pages (Sessions, Workspace, Agents, ...) │
├─────────────────────────────────────────┤
│  Delegates (one per message type)        │
├──────────────┬──────────────────────────┤
│  ViewModels  │  Components (reusable UI) │
├──────────────┴──────────────────────────┤
│  WS Layer (GatewayClient → WSClient → Router) │
├─────────────────────────────────────────┤
│  Registries (Pages, UI, ToolCards, Slots)│
├─────────────────────────────────────────┤
│  Infrastructure (EventEmitter, Logger, Markdown) │
└─────────────────────────────────────────┘
```

## Core Infrastructure

### EventEmitter

Typed observer base class used by all viewmodels and the WS layer.

```ts
class EventEmitter {
  on(event: string, handler: (...args: any[]) => void): this;
  off(event: string, handler: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): void;
  setMaxListeners(n: number): void;
  removeAllListeners(): void;
  listenerCount(event: string): number;
}
```

### MarkdownRenderer

Safe markdown-to-HTML conversion (~354 lines). No external library.

```ts
function renderMarkdown(text: string): string;
```

**Safety:** Whitelist-based HTML sanitization. All `<script>`, `<iframe>`, event handlers, and `javascript:` URLs stripped. Code blocks isolated and highlighted separately.

**Pipeline:** HTML sanitize → escape unsafe HTML → inline markdown (links, bold, italic, code, images) → linkify file paths → block-level (headings, tables, lists, blockquotes, task lists).

### ClientLogger (Singleton)

Pino-like structured logger with ring buffer.

```ts
class ClientLogger {
  // Static convenience accessors
  static ui: ClientLogger;
  static ws: ClientLogger;
  static vm: ClientLogger;
  static api: ClientLogger;
  static app: ClientLogger;
  static render: ClientLogger;

  debug(msg: string, data?: any): void;
  info(msg: string, data?: any): void;
  warn(msg: string, data?: any): void;
  error(msg: string, data?: any): void;
}
```

Ring buffer: 500 entries, last 200 persisted to localStorage (debounced 5s).

### ToastManager (Singleton)

```ts
class ToastManager {
  success(msg: string, duration?: number): string;  // Returns toast ID
  error(msg: string, duration?: number): string;
  info(msg: string, duration?: number): string;
  dismiss(id: string): void;
}
```

### ClickablePathHandler

Delegated click handler for file paths and external URLs. Workspace-relative paths resolved via `window.electronAPI.openPath()` / `openExternal()`.

---

## WebSocket Layer (3 tiers)

### Tier 1: GatewayClient (`lib/GatewayClient.ts`)

Low-level transport. Single persistent WebSocket to `ws://host/ws`.

```ts
class GatewayClient extends EventEmitter {
  connect(): void;
  disconnect(): void;
  send(data: Record<string, unknown>): void;
  isConnected(): boolean;

  // Typed events via channel names, catch-all via onAny
  on(type: string, handler: Function): this;
  onAny(handler: (type: string, data: any) => void): this;
  onStateChange(handler: (state: string) => void): this;
}
```

**State machine:** `idle → connecting → open → closed/error`  
**Auto-reconnect:** exponential backoff `1s * 2^(n-1)` + jitter, max 30s, 20 attempts  
**Heartbeat:** 30s ping interval  
**Server restart detection:** `serverEpoch` comparison on connect

### Tier 2: WSClient (`viewmodel/WSClient.ts`)

Public API wrapping GatewayClient.

```ts
enum WSConnectionState { Connecting, Connected, Disconnected }

class WSClient {
  connect(): void;
  disconnect(): void;
  sendMessage(sessionId: string, content: string, mode?: string, ...): void;
  stopGeneration(sessionId: string): void;
  runCommand(sessionId: string, command: string, args?: object): void;
  sendPing(): void;
  sendEditorContext(sessionId: string, context: EditorContext): void;
  send(type: string, data: Record<string, unknown>): void;

  on(event: string, handler: Function): this;
  off(event: string, handler: Function): this;
}
```

**Events:** `connectionStateChanged`, `reconnected`, `connectionLost`, `serverRestarted`, `event({ type, data, sessionId })`.

### Tier 3: WSMessageRouter (`viewmodel/WSMessageRouter.ts`)

Pluggable typed router. Replaces scattered event listeners.

```ts
class WSMessageRouter {
  on(type: string, handler: (ctx: WSHandlerContext) => void): void;
  dispatch(type: string, data: any, sessionId: string): void;
}
```

**Handler registration** via `ChatHandlers.ts`:
```
event → router.dispatch(type, data, sessionId)
  → sessionAgent.onServerEvent(type, data)
    → pure functions: onThink/onText/onToolCall/onDone/...
      → mutate SessionState + emit events → UI updates
```

---

## ViewModel Layer

### App (`app.ts`)

Singleton bootstrap. Initializes all services on `DOMContentLoaded`.

```ts
class App {
  static getInstance(): App;
  // Initializes WS, pages, sessions, agents, plugins, theme,
  // hash routing, floating ball events
  async init(): Promise<void>;
}
```

### PageRegistry

```ts
interface Page {
  name: string;
  container: HTMLElement;
  onEnter(): void;
  onExit(): void;
}

class PageRegistry {
  register(page: Page): void;
  navigateTo(name: string): void;
  getPage(name: string): Page | undefined;
}
```

Lifecycle: hides current (display:none + opacity), shows next (display:block + CSS fade-in), calls `onExit()` / `onEnter()`.

### ConversationViewModel

Session-agnostic state hub.

```ts
class ConversationViewModel extends EventEmitter {
  inputValue: string;
  permissionMode: string;
  runningMode: string;
  effortMode: boolean;

  setActiveSession(sessionId: string): void;
  getAgent(sessionId: string): SessionAgent | undefined;
  onConnectionLost(): void;
}
```

### SessionViewModel

```ts
class SessionViewModel extends EventEmitter {
  loadSessions(): Promise<void>;
  selectSession(sessionId: string): void;
  createSession(agentId?: string, title?: string, parentSessionId?: string): Promise<string>;
  archiveSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
}
```

### SessionAgent (per-session)

One instance per active session. Owns its own `EventEmitter`, `SessionState`, and `MessageListModel`.

```ts
class SessionAgent extends EventEmitter {
  readonly sessionId: string;
  readonly state: SessionState;

  onServerEvent(type: string, data: any): void;
  loadHistory(): Promise<void>;
}
```

**Event handler pipeline** (12 pure functions): `onThink`, `onText`, `onToolCall`, `onToolResult`, `onDone`, `onError`, `onPlanEnter`, `onPlanExit`, `onTodoWrite`, `onDelegationProgress`, `onDelegationStatus`, `onTaskNotification`, `onStatus`.

### SessionState

```ts
class SessionState {
  messages: MessageListModel;
  isStreaming: boolean;
  currentStreamMessage: Message | null;
  tokenBreakdown: TokenBreakdown | null;
}
```

### MessageListModel

Observable array with events.

```ts
class MessageListModel extends EventEmitter {
  appendMessage(msg: Message): void;
  updateMessage(id: string, updates: Partial<Message>): void;
  replaceLastMessage(msg: Message): void;
  removeMessage(id: string): void;
  clear(): void;
  // Events: rowsInserted, rowsRemoved, dataChanged
}
```

### AgentViewModel

```ts
class AgentViewModel extends EventEmitter {
  agents: AgentConfig[];

  loadAgents(): Promise<void>;
  createAgent(config: Partial<AgentConfig>): Promise<void>;
  updateAgent(id: string, config: Partial<AgentConfig>): Promise<void>;
  deleteAgent(id: string, cascade?: boolean): Promise<void>;
  buildTree(): AgentConfig[];
}
```

---

## Registries (Extension System)

### UIComponentRegistry

Plugin component overrides.

```ts
class UIComponentRegistry {
  register(name: string, component: any): void;
  unregister(name: string): void;
  get<T>(name: string): T | undefined;
}
```

### ToolCardRegistry

Tool-name-to-card-class mapping.

```ts
class ToolCardRegistry {
  register(name: string, cardClass: any): void;
  get(toolName: string, cardStyle?: string): any;
}
```

Presets: `default` → ToolCard, `result` → ToolCardResult, `diff` → ToolCardDiff, `progress` → ToolCardProgress, `error` → ToolCardError.

### SlotRegistry

Plugin DOM injection.

```ts
class SlotRegistry {
  mount(slot: string, el: HTMLElement, position?: 'append' | 'prepend', replace?: boolean, pluginName?: string): void;
  unmount(slot: string, el: HTMLElement): void;
  unmountAll(slot: string): void;
  removeByPlugin(pluginName: string): void;
}
```

Targets `[data-slot="name"]` elements. Queue-and-drain pattern.

---

## Delegate Pattern

One TS file per message type in `components/conversation/delegates/`:

| Delegate | Renders |
|----------|---------|
| `UserMessageDelegate.ts` | User message bubble |
| `AgentMessageDelegate.ts` | Complete assistant message |
| `StreamingMessageDelegate.ts` | Live streaming text |
| `ToolCallDelegate.ts` | Tool invocation card |
| `ToolResultDelegate.ts` | Tool result display |
| `ThinkDelegate.ts` | Thinking/reasoning block |
| `SystemMessageDelegate.ts` | System notification |
| `TodoWriteDelegate.ts` | Todo list |
| `PlanIndicator.ts` | Plan mode boundary |
| `DelegationActivityDelegate.ts` | Sub-agent activity |
| `SubSessionCardDelegate.ts` | Linked sub-session |
| `EditResultDelegate.ts` | File edit result |
| `StatusDelegate.ts` | Inline status |
| `TaskNotificationDelegate.ts` | Background task result |
| `ToolActivityDelegate.ts` | Tool execution activity |

---

## Subdirectories

- `viewmodel/` — WS client, message router, session/agent/conversation state management
- `components/conversation/` — Chat UI (input, message list, mode selector, session tree, slash commands)
- `components/conversation/delegates/` — One file per message type
- `components/pages/` — Full-page views (Sessions, Workspace, Agents, Settings, Skills, Memory, Plugins)
- `components/pages/workspace/` — Workspace file tree, tabs, split view
- `components/tabs/` — Sidebar tabs (Files, Overview, Plan, Background Tasks)
- `components/evolution/` — Star rating widget
- `components/ui/` — Reusable UI kit (Button, Card, Dialog, Toggle, Input, Select, Badge, Toast, etc.)
- `handlers/` — WS event → SessionAgent dispatch
- `utils/` — Color utilities, clickable path handler
- `lib/` — Low-level GatewayClient

---

## Data Flow

```
User types message → InputPanel fires 'send-message'
  → ConversationViewModel.getAgent(sessionId).sendMessage()
    → WSClient.sendMessage(sessionId, content, mode)
      → GatewayClient.send({ type: 'send_message', ... })
        → WebSocket → Server processes

Server streams response:
  GatewayClient.onAny({ type: 'text_delta', _sessionId, ... })
    → WSClient emits 'event' { type: 'text_delta', data, sessionId }
      → WSMessageRouter.dispatch('text_delta', data, sessionId)
        → SessionAgent.onText(data)
          → SessionState.messages.appendMessage(...)
            → MessageListModel emits 'rowsInserted'
              → MessageListView re-renders via delegate
```

## Dependencies

No npm dependencies. All imports are relative paths with `.js` extension. No path aliases in frontend code.
