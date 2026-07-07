# src/server/gateway — Gateway Layer

## Overview

Dual HTTP server architecture with API authentication, declarative route registration, and a WebSocket-to-Gateway bridge for external chat platforms (Telegram, Discord, Feishu, etc.).

### Two HTTP Servers
| Server | Port | Purpose |
|--------|------|---------|
| main.ts HTTP | 3456 | Static files + WebSocket + API proxy |
| ApiServer | 15730 | External AI Agent control API (localhost only) |

## Public Interface

### ApiServer (Singleton)

REST API server on port 15730 (localhost only). Extends `EventEmitter`.

```ts
class ApiServer extends EventEmitter {
  static getInstance(): ApiServer;

  // Start listening
  start(port?: number, host?: string): void;

  // Register a declarative route handler
  registerRoute(handler: RouteHandler): void;

  // Main request entry point (delegated from main.ts)
  handleApiRequest(req: IncomingMessage, res: ServerResponse): void;

  // In-process API call (bypasses network, uses __internal__ token)
  async callInternal(method: string, path: string, body?: Record<string, unknown>): Promise<ApiResponse>;

  // Lifecycle
  stop(): Promise<void>;
  isRunning(): boolean;
}
```

**Auth flow:**
1. Localhost + `/api/v1/health` → no auth required
2. Remote requests → requires `Authorization: Bearer <token>` header
3. In-process calls → uses hardcoded `__internal__` token with all permissions

**Rate limiting:** Per-token (default 60 rpm) and global (default 300 rpm). Internal token bypasses.

**Routing priority:** Declarative route table checked first, then legacy if-else chain, then plugin routes, then 404.

**Events:** `started`, `error`, `stopped`, `requestReceived`.

**CORS:** `Access-Control-Allow-Origin: *`, 24h preflight max-age.

---

### RouteHandler Interface

```ts
interface RouteHandler {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;              // Pattern with :param segments
  description?: string;      // For endpoint discovery
  category?: string;         // Grouping for endpoint discovery
  permission?: string;       // Optional permission gate
  handle(
    match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    token: ApiToken | null
  ): Promise<boolean> | boolean;
}

interface RouteMatch {
  segments: string[];                  // e.g. ['api','v1','sessions','abc']
  params: Record<string, string>;      // e.g. { id: 'abc' }
  query: URLSearchParams;
}
```

### RouteHelpers

Standalone utilities decoupled from ApiServer.

```ts
// Send JSON response
function sendJson(res: ServerResponse, status: number, data: unknown): void;

// Read request body as JSON (returns {} on empty/invalid)
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
```

### ApiAuth

Token management and validation.

```ts
// Validate a Bearer token string
function validateToken(token: string): ApiToken | null;

// Check if token has a specific permission
function hasPermission(token: ApiToken, permission: ApiPermission): boolean;

// Generate a new token (format: ano_sk_<32 hex>)
function generateToken(name: string, permissions: ApiPermission[]): ApiToken;

// List all tokens (masks by default, showing only first 12 chars)
function listTokens(mask?: boolean): ApiToken[];

// Remove a token
function revokeToken(token: string): boolean;

// Token count
function tokenCount(): number;

// Load tokens from config/api.json, auto-generate admin token if none exist
async function initAuthStore(configDir?: string): Promise<void>;
```

**ApiPermission values:** `sessions:read`, `sessions:write`, `messages:read`, `messages:send`, `agents:read`, `agents:write`, `workspace:read`, `memory:read`, `memory:write`, `admin`.

### WsRequired

Guards for HTTP write endpoints requiring an active WebSocket connection.

```ts
// Check specific session has WS connection (returns false + 503 if not)
function requireWs(sessionId: string, res: ServerResponse, sendJson: SendJson): boolean;

// Check any WS connection exists
function requireWsAny(res: ServerResponse, sendJson: SendJson): boolean;
```

### GatewayRouter (Singleton) — PLANNED

**Status: Planned, not yet implemented.** Will bridge external platform messages (Telegram, Discord, WeChat, etc.) into AnoClaw agent sessions.

```ts
class GatewayRouter extends EventEmitter {
  static getInstance(): GatewayRouter;

  // Register a platform adapter
  registerAdapter(platform: string, adapter: PlatformAdapter): void;

  // Route an incoming platform message to an agent session
  async routeIncoming(msg: PlatformMessage): Promise<void>;

  // Send a reply back to a platform
  async sendToPlatform(platform: string, chatId: string, content: string, opts?: MessageOptions): Promise<void>;

  // Platform listing
  adapter(platform: string): PlatformAdapter | undefined;
  registeredPlatforms(): string[];

  // Session mapping
  bindSessionToChat(platform: string, chatId: string, userId: string, sessionId: string): void;
  listMappings(): Record<string, string>;
  resetMappings(): void;
}
```

**PlatformAdapter interface:**
```ts
interface PlatformAdapter extends EventEmitter {
  readonly platform: string;
  isConnected(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, content: string, options?: MessageOptions): Promise<void>;
}
```

**Events:** `messageRouted`, `messageSent`, `platformConnected`, `platformDisconnected`.

---

## Dependencies

```
ApiServer     → ApiAuth, RouteHandler, RouteHelpers, handlers/*, routes/*
ApiAuth       → crypto, fs, shared/types/gateway
RouteHandler  → node:http (types), ApiAuth (types)
RouteHelpers  → node:http (types)
WsRequired    → WsServer
GatewayRouter → SessionManager, AgentRegistry, AgentRuntime, shared/types/session
```

## Usage

```ts
import { ApiServer } from './gateway/ApiServer.js';
import { initAuthStore } from './gateway/ApiAuth.js';

// Initialize tokens
await initAuthStore();

// Start API server
const api = ApiServer.getInstance();
api.start(15730, '127.0.0.1');

// Register a custom route
api.registerRoute({
  method: 'GET',
  path: '/api/v1/custom/status',
  category: 'Custom',
  description: 'Custom status endpoint',
  handle(match, req, res, token) {
    sendJson(res, 200, { status: 'ok' });
    return true;
  },
});

// Call another endpoint internally
const result = await api.callInternal('GET', '/api/v1/health');
console.log(result.body); // { status: 'ok', ... }
```
