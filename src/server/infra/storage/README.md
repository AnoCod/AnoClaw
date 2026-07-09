# src/server/infra/storage — Storage & Persistence Layer

## Overview

JSONL-based session persistence (append-only, sharded, archived), YAML/JSON settings manager with hot-reload and extension point overrides, and a repository adapter bridging the infrastructure layer to the domain persistence contract.

## Public Interface

### SettingsManager (Singleton)

YAML/JSON configuration store with dot-notation access, deep merge of defaults, and file watching for hot-reload.

```ts
class SettingsManager extends EventEmitter {
  static getInstance(): SettingsManager;

  // Load config from disk (YAML preferred, JSON fallback)
  async load(): Promise<void>;

  // Dot-notation read (e.g. 'llm.model', 'ui.theme')
  get<T>(key: string, defaultValue?: T): T;

  // Dot-notation write (in-memory, emits 'changed')
  async set(key: string, value: unknown): Promise<void>;

  // Persist in-memory state to disk
  async save(): Promise<void>;

  // Plugin extension point injection
  setExtensionPoints(extPoints: ExtensionPoints): void;

  // Read-only accessors
  loaded: boolean;
  all: Record<string, unknown>;

  // Cleanup
  stopWatching(): void;
}
```

**Default settings structure:**
```
server:       { host: '127.0.0.1', port: 3456, apiPort: 15730 }
llm:          { provider: 'openai-compatible', model: 'deepseek-chat', maxTokens: 200000, temperature: 1.0, apiKey: '', apiUrl: 'https://api.deepseek.com' }
agent:        { maxTurns: 0, stallDetectionNoToolTurns: 5, stallDetectionConsecutiveFailures: 3, heartbeatIntervalSec: 60, taskTimeoutSec: 600, unresponsiveThresholdSec: 180 }
logging:      { level: 'info', logDir: 'logs', maxFileBytes: 10MB, maxFiles: 10 }
rateLimit:    { perMinute: 100, enabled: true }
workspace:    { root: 'company-workspace' }
features:     { enableMCP: true, enableSSE: true, enableCache: true, enableDelegation: true, enableSkills: true }
ui:           { lang: 'zh', theme: 'dark', accentColor: '#0b8ce9', showThinkCards: true, showToolCards: true, compactionThreshold: 70 }
```

**Events:** `'changed'` (key, value) — emitted on every `set()` call.

---

### JsonlStore (Singleton)

Append-only JSONL persistence engine with per-session sharding and gzip archiving.

```ts
class JsonlStore extends EventEmitter {
  static getInstance(): JsonlStore;

  // Append one event to a session's current shard
  async appendEvent(sessionId: string, event: JsonlEvent, opts?: { skipMetaUpdate?: boolean }): Promise<void>;

  // Read all events for a session (handles .jsonl and .jsonl.gz)
  async readEvents(sessionId: string, fromShard?: number): Promise<JsonlEvent[]>;

  // Metadata operations (with per-session sequential lock)
  async getMeta(sessionId: string): Promise<SessionMeta>;
  async updateMeta(sessionId: string, updates: Partial<SessionMeta>): Promise<void>;

  // Cache management
  invalidateMetaCache(sessionId: string): void;
  dropSession(sessionId: string): void;

  // Delete all shard files for a session
  async truncateSession(sessionId: string): Promise<void>;

  // Compress old shards to .jsonl.gz (after 30 days)
  async archiveSession(sessionId: string): Promise<void>;
}
```

**Sharding constants:** `SHARD_MAX_LINES = 10,000`, `SHARD_MAX_BYTES = 10 MB`, `ARCHIVE_AGE_DAYS = 30`.

**Disk layout:**
```
data/sessions/{sessionId}/
  meta.json              # Session metadata
  shards.json            # Shard index [0, 1, 2, ...]
  shard_000000.jsonl     # Append-only events
  shard_000001.jsonl.gz  # Archived (30+ days idle)
```

**Events:** `shardRotated`, `eventAppended`, `sessionArchived`.

---

### JsonlSessionRepository implements ISessionRepository

Adapter bridging the domain `ISessionRepository` interface to the `SessionStore` singleton.

```ts
class JsonlSessionRepository implements ISessionRepository {
  constructor();  // Internally grabs SessionStore.getInstance()

  async load(sessionId: string): Promise<{ meta: SessionMeta; messages: Message[] } | null>;
  async saveMeta(sessionId: string, meta: Partial<SessionMeta>): Promise<void>;
  async appendMessage(sessionId: string, message: Message): Promise<void>;
  async rewriteMessages(sessionId: string, messages: Message[]): Promise<void>;
  async listSessions(): Promise<SessionMeta[]>;
  async deleteSession(sessionId: string): Promise<void>;
}
```

---

## Dependencies

```
SettingsManager       → events, fs/promises, yaml, shared/constants, LogManager, WritablePath
JsonlStore            → events, fs/promises, zlib, readline, shared/constants, shared/types/session
JsonlSessionRepository → SessionStore, shared/types/session, core/session/ISessionRepository
```

## Usage

```ts
import { SettingsManager } from './infra/storage/SettingsManager.js';

const settings = SettingsManager.getInstance();
await settings.load();

const model = settings.get('llm.model', 'deepseek-chat');
await settings.set('ui.theme', 'light');
await settings.save();
```

```ts
import { JsonlStore } from './infra/storage/JsonlStore.js';

const store = JsonlStore.getInstance();
await store.appendEvent('session-123', {
  type: 'message',
  role: 'user',
  content: 'Hello',
  timestamp: Date.now(),
});

const events = await store.readEvents('session-123');
const meta = await store.getMeta('session-123');
```
