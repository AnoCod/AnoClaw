# Session Subsystem

Session lifecycle management, JSONL persistence, file history tracking, and
message withdrawal. Sessions form a tree (Main → Sub → Sub) with inherited
workspaces and per-session concurrency control.

## Modules

| Module | Responsibility |
|--------|---------------|
| `SessionManager` | Singleton — create, query, mutate sessions; message history |
| `Session` | Domain class — wraps `SessionNode` with behavior |
| `SessionLeaseManager` | Lease tokens for concurrent session execution |
| `SessionStore` | Persistence coordinator — JSONL, meta.json, recovery |
| `JsonlStore` | Append-only JSONL store with sharding and archival |
| `FileHistoryTracker` | File change tracking, snapshots, and rewind for withdrawal |
| `MessageWithdrawalManager` | Message withdrawal with file rollback and irreversible-action detection |

---

## SessionManager (Singleton)

Central hub for session lifecycle. Extends `EventEmitter`. Manages in-memory
`Session` instances, delegates persistence to `SessionStore`.

### `getInstance(): SessionManager`

### Initialization

- **`initialize(sessionsDir: string): Promise<void>`** — scan `data/sessions/`,
  recover all sessions from disk, set first non-archived main session as active.

### Creation

- **`createMainSession(agentId, title?, workspace?): Promise<Session>`**

  Create a new level-0 main session. Auto-generates a workspace directory if not
  specified: `workspace/{sessionId}`. Persists `session_created` event to JSONL.

- **`createSubSession(parentSessionId, agentId, title?): Promise<Session>`**

  Create a child session (level = parent.level + 1). Inherits parent's workspace.
  Deduplicates — returns existing active sub-session for the same
  `(parentSessionId, agentId)` pair if one exists. Notifies parent agent via
  system message injection.

### Query

- **`session(sessionId: string): Session | undefined`** — get by ID.
- **`listSessions(status?): Session[]`** — all sessions, optionally filtered.
- **`mainSessions(): Session[]`** — active level-0 sessions.
- **`activeSessions(): Session[]`** — all non-archived sessions.
- **`subsessionsOf(parentSessionId): Session[]`** — direct children.
- **`getParentSession(sessionId): Session | undefined`** — parent session.
- **`getSubSessions(sessionId): Session[]`** — direct children (alias).
- **`getRootSession(sessionId): Session`** — walk up to level-0 root.
- **`getSessionTree(): SessionNode[]`** — full active session tree.

### Active session

- **`activeMainSession(): Session | undefined`** — currently active main session.
- **`setActiveSession(sessionId): void`** — set the active session (emits `activeSessionChanged`).
- **`getActiveSessionId(): string`** — get the active session ID.

### Messages

- **`appendMessage(sessionId, message): Promise<void>`**

  Append a message to session history. Protected by per-session sequential lock
  (`_withLock`). Converts message to JSONL events, persists to `SessionStore`,
  updates in-memory cache, increments external message counter, emits
  `messageAppended` and `session:message_appended`.

- **`getMessageCount(sessionId): number`**

  Lockless read of the external message counter. Used by `AgentLoop` for inter-turn
  message detection.

- **`getHistory(sessionId, flat?): Promise<Message[]>`**

  Read full message history. Returns in-memory cache if available. Falls back to
  `SessionStore.loadHistory()` for disk reads.

- **`rebuildMessageCache(sessionId): Promise<void>`**

  Rebuild in-memory cache from disk. Fire-and-forget — called after each agent
  turn.

- **`rewriteHistory(sessionId, messages): Promise<void>`**

  Replace entire history with compacted messages. Truncates all shards, re-appends
  each message as a fresh event. Used by `CompactCommand`.

### Lifecycle

- **`setTitle(sessionId, title): Promise<void>`** — update session title.
- **`setWorkspace(sessionId, workspace): Promise<void>`** — update workspace path.
- **`setMetadata(sessionId, key, value): void`** — set arbitrary metadata.
- **`archiveSession(sessionId): Promise<void>`** — archive session and all children recursively.
- **`setRunningMode(sessionId, mode): void`** — set `'normal'` or `'infinite'`.
- **`getRunningMode(sessionId): string`** — read running mode.

### Internal (package-private)

- **`registerSession(session): void`** — directly register a recovered `Session`
  (used by `SessionStore` during startup recovery).
- **`clearAll(): void`** — remove all sessions from memory (does not touch disk).

### Session tree

```
MainSession (level 0, User ↔ Agent)
  └── SubSession (level 1, Agent ↔ Agent)
        └── SubSession (level 2, Agent ↔ Agent)
```

Sub-sessions inherit the parent's **workspace**. Sub-session ID format:
`{parentSessionId}-{agentId}`.

### Concurrency control

**Per-session sequential lock** (`_withLock`): prevents race conditions between
concurrent mutations on the same session (e.g., `appendMessage` vs `setTitle`).

**Concurrent turn guard** (`AgentRuntime._activeLoops`): prevents multiple
`AgentLoop` instances on the same session. The second message is queued as a
soft interrupt (`InterruptController.setPendingUserMessage()`).

---

## Session

Domain class wrapping a `SessionNode`. All mutations update `lastActiveAt`.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` / `sessionId` | `string` | Unique session ID |
| `parentSessionId` | `string \| null` | Parent session (null for Main) |
| `level` | `number` | Depth in tree (0 = root) |
| `agentId` | `string` | Agent serving this session |
| `type` | `SessionType` | `'Main'` or `'Sub'` |
| `status` | `SessionStatus` | `'Active'` / `'Idle'` / `'Archived'` |
| `title` | `string` | Display title |
| `workspace` | `string` | Absolute workspace path |
| `createdAt` | `string` | ISO timestamp |
| `lastActiveAt` | `string` | ISO timestamp |
| `subSessionIds` | `string[]` | Child session IDs |
| `metadata` | `Record<string, unknown>` | Extension point for plugins |
| `lastEventUuid` | `string \| null` | UUID of last JSONL event (for chaining) |
| `cachedMessages` | `Message[] \| null` | In-memory message cache |

### Predicates

- **`isMain(): boolean`** — type is `'Main'`.
- **`isSub(): boolean`** — type is `'Sub'`.
- **`isActive(): boolean`** — status is `'Active'`.
- **`isArchived(): boolean`** — status is `'Archived'`.
- **`hasParent(): boolean`** — parentSessionId is not null.
- **`isRoot(): boolean`** — level is 0.

### Mutations

- **`archive(): void`** — status → `'Archived'`.
- **`setIdle(): void`** — `Active` → `'Idle'`.
- **`setActive(): void`** — `Idle` → `'Active'` (or refresh).
- **`updateTitle(title): void`** — update title.
- **`setWorkspace(workspace): void`** — update workspace.
- **`addSubSession(id): void`** — add child session ID.
- **`removeSubSession(id): void`** — remove child session ID.
- **`setMetadata(key, value): void`** — set arbitrary metadata.
- **`touch(): void`** — refresh `lastActiveAt`.

### Serialization

- **`toJSON(): SessionNode`** — deep copy of the node.
- **`raw(): Readonly<SessionNode>`** — read-only reference (use with caution).

---

## SessionLeaseManager (Singleton)

Lease-based session execution tracking. No global concurrency limit — AnoClaw is
a team collaboration platform. Per-session concurrency is enforced by
`AgentRuntime._activeLoops`.

### `getInstance() / resetInstance()`

### `acquire(sessionId): LeaseToken | null`

Acquire or refresh a lease for a session. Always succeeds (no global limit).
Returns the lease token: `{ sessionId, acquiredAt, lastActivityAt }`.

### `release(sessionId): void`

Release the lease.

### `touch(sessionId): void`

Update `lastActivityAt` on an existing lease.

### `activeCount: number`

Number of active leases.

### `activeSessionIds: string[]`

List of leased session IDs.

### Reaper

- **`start(): void`** — start periodic reaping (default: every 30s).
- **`stop(): void`** — stop periodic reaping.

The reaper removes leases that have been idle for > 5 minutes (configurable via
`_idleTimeoutMs`).

---

## Persistence

### SessionStore (Singleton)

Coordinates persistence between `SessionManager` and `JsonlStore`. Handles directory
management, startup recovery, and garbage collection.

#### `getInstance(): SessionStore`

#### Initialization

- **`initialize(sessionsDir): Promise<void>`** — set sessions directory, create
  if missing. Creates `_file-history/` subdirectory.

#### Recovery

- **`recoverSessions(): Promise<Session[]>`** — scan `data/sessions/` directories,
  read `meta.json` files, rebuild `Session` instances. Skips archived sessions.
  Repairs missing/corrupt meta.json by reconstructing from events.

#### Metadata

- **`readSessionMeta(sessionId): Promise<SessionNode | null>`** — read `meta.json`.
- **`writeSessionMeta(sessionId, node): Promise<void>`** — write `meta.json`.
- **`updateMeta(sessionId, updates): Promise<void>`** — partial update to `meta.json`
  (delegates to `JsonlStore`).

#### Event persistence

- **`persistEvent(sessionId, event, opts?): Promise<void>`** — write a single
  event to the session's JSONL transcript. Creates session directory if missing.
  Supports plugin override via `extensionPoints.get('sessionStore')`.
- **`loadHistory(sessionId): Promise<unknown[]>`** — load all transcript events.
  Supports plugin override.
- **`truncateSession(sessionId): Promise<void>`** — delete all shard files
  (used before rewriting compacted history).

#### Lifecycle

- **`archiveSession(sessionId): Promise<void>`** — gzip-compress old shards,
  mark meta as Archived.
- **`deleteSession(sessionId): Promise<void>`** — permanently delete session
  directory from disk.
- **`deleteAllSessions(): Promise<number>`** — delete all session directories
  (but preserve `_file-history` and other underscore-prefixed dirs).
- **`garbageCollect(): Promise<number>`** — archive sessions idle > 90 days,
  compress old shards.

#### File history directories

- **`ensureFileHistoryDir(sessionId): Promise<string>`** — create and return the
  file history backup directory for a session.
- **`getSessionFileHistoryDir(sessionId): string`** — path to file history dir.
- **`pruneFileHistory(sessionId): Promise<number>`** — delete old backups
  exceeding `FILE_HISTORY_MAX_SNAPSHOTS`.

### JsonlStore (Singleton, in `infra/storage/`)

Append-only JSONL store with automatic sharding. Each session's events are stored
in `data/sessions/{sessionId}/shard_NNNNNN.jsonl`.

#### Sharding strategy

| Constraint | Value |
|-----------|-------|
| Max lines per shard | `SHARD_MAX_LINES` (10,000) |
| Max bytes per shard | `SHARD_MAX_BYTES` (10 MB) |
| Archive age | `ARCHIVE_AGE_DAYS` (30 days) |

When a shard reaches either limit, a new shard is created with the next index.
Archived shards are gzip-compressed.

#### Public API

- **`getInstance(): JsonlStore`**
- **`appendEvent(sessionId, event, opts?): Promise<void>`** — append one JSONL
  event. Rotates shard when limits are reached. Increments message count in meta.
- **`readEvents(sessionId, fromShard?): Promise<JsonlEvent[]>`** — read all events
  from all shards (or starting from a specific shard). Handles gzip-compressed
  archives transparently.
- **`getMeta(sessionId): Promise<SessionMeta>`** — read session metadata
  (`messageCount`, `tokenBreakdown`, timestamps). Returns defaults if missing.
- **`updateMeta(sessionId, updates): Promise<void>`** — partial metadata update.
  Uses per-session sequential lock to prevent read-modify-write races.
- **`invalidateMetaCache(sessionId): void`** — clear cached meta.
- **`dropSession(sessionId): void`** — clear all cached state for a session.
- **`truncateSession(sessionId): Promise<void>`** — delete all shard files.
- **`archiveSession(sessionId): Promise<void>`** — gzip-compress old shards.

### FileHistoryTracker (Singleton)

Tracks file edits and creates versioned backups for message withdrawal support.
Backups stored at `data/sessions/_file-history/{sessionId}/{hash}@v{version}`.

#### Public API

- **`getInstance(): FileHistoryTracker`**
- **`trackEdit(sessionId, filePath, messageId): Promise<void>`** — create a backup
  BEFORE a file is mutated. Called by Edit/Write tools.
- **`makeSnapshot(sessionId, messageId): Promise<void>`** — create a file snapshot
  after each user message. Captures the state of all tracked files. Prunes old
  snapshots beyond `FILE_HISTORY_MAX_SNAPSHOTS`.
- **`rewindTo(sessionId, messageId): Promise<string[]>`** — restore all tracked
  files to the state they had at a specific message's snapshot. Returns list of
  restored file paths.
- **`hasAnyChanges(sessionId, messageId): Promise<boolean>`** — lightweight check
  whether rewinding to a message would change any files.
- **`getTrackedFiles(sessionId): string[]`** — list all tracked file paths.
- **`clearSession(sessionId): Promise<void>`** — delete all file history for a
  session.
- **`restoreStateFromSnapshots(sessionId, snapshots): void`** — restore in-memory
  state from persisted snapshots (used during session recovery).

### MessageWithdrawalManager (Singleton)

Coordinates message withdrawal: marks messages as withdrawn, restores files from
snapshots, and detects irreversible side effects.

#### Public API

- **`getInstance(): MessageWithdrawalManager`**

- **`previewWithdrawal(sessionId, messageId): Promise<WithdrawalPreview>`**

  Preview what would happen: `{ affectedFiles, messagesToTruncate,
  hasIrreversibleActions, irreversibleDetails }`.

- **`withdrawMessage(sessionId, messageId): WithdrawalResult`**

  Synchronous variant — persists withdrawal marker. File rewind delegated to
  `withdrawMessageAsync`.

- **`withdrawMessageAsync(sessionId, messageId): Promise<WithdrawalResult>`**

  Async variant — full transcript analysis, file rollback, withdrawal marker
  persistence. Returns `{ success, restoredFiles, irreversibleActions,
  truncatedMessageCount }`.

- **`isIrreversibleToolCall(toolName, params?): boolean`** (static)

  Check if a tool call has irreversible side effects. Detects Bash commands
  like `git push`, `npm publish`, `docker push`, `rm -rf`, `drop table`, etc.
  Also flags `TaskAssign`, `TaskStop`, and `WebFetch` as irreversible.

**Irreversible detection patterns**:
```
git push | npm publish | docker push | curl POST/PUT/DELETE
rm -rf | rmdir | del /s | drop table | delete from | truncate table
shutdown | reboot
```

---

## Dependencies

### Called by
- **Gateway**: `SessionHandlers`, `WorkspaceHandlers`, `ToolHandlers`, `SystemHandlers`,
  `GatewayRouter`, `AgentExecuteRoute`, `SessionControlRoutes`, `SessionTreeRoutes`,
  `SessionMessageRoute`, `ToolExecuteRoute`, `InlineSuggestHandler`, `SystemInfoRoute`
- **Core**: `AgentRuntime`, `AgentLoop`, `AgentDelegation`, `MessageWithdrawalManager`,
  `FileHistoryTracker`

### Depends on
- **Infra**: `JsonlStore` (storage), `StreamPersister` (event persistence),
  `StreamConsumer` (WS streaming)
- **Agent**: `AgentRegistry` (for `createSubSession` agent name lookup)
- **Context**: `TokenCounter` (for `rewriteHistory` breakdown)
- **Tools**: `ToolRegistry` (for `rewriteHistory` tool definitions)
- **Prompt**: `PromptAssembler` (for `rewriteHistory` system prompt)
- **Events**: `TypedEventBus`
- **Constants**: `DEFAULT_MAIN_AGENT_ID`, `FILE_HISTORY_MAX_SNAPSHOTS`, `SHARD_MAX_LINES`,
  `SHARD_MAX_BYTES`, `ARCHIVE_AGE_DAYS`

---

## Usage Example

```ts
import { SessionManager } from './core/session/SessionManager.js';
import { SessionStore } from './core/session/SessionStore.js';
import { SessionLeaseManager } from './core/session/SessionLeaseManager.js';
import { FileHistoryTracker } from './core/session/FileHistoryTracker.js';
import { MessageWithdrawalManager } from './core/session/MessageWithdrawalManager.js';

// 1. Initialize at startup
const sm = SessionManager.getInstance();
await sm.initialize('/abs/path/to/data/sessions');

// 2. Create a main session
const mainSession = await sm.createMainSession('main-agent', 'My Project');

// 3. Create a sub-session for delegation
const subSession = await sm.createSubSession(
  mainSession.id,
  'manager-research',
  'Research competitors',
);
// subSession.workspace === mainSession.workspace (inherited)

// 4. Append messages
await sm.appendMessage(mainSession.id, {
  id: 'msg-1',
  sessionId: mainSession.id,
  role: 'user',
  content: 'Build a landing page',
  tokenCount: 4,
  compressed: false,
  timestamp: new Date().toISOString(),
});

// 5. Read history
const history = await sm.getHistory(mainSession.id);

// 6. Track file edits
const fht = FileHistoryTracker.getInstance();
await fht.trackEdit(mainSession.id, '/path/to/file.ts', 'msg-1');
await fht.makeSnapshot(mainSession.id, 'msg-1');

// 7. Withdraw a message and roll back files
const mwm = MessageWithdrawalManager.getInstance();
const preview = await mwm.previewWithdrawal(mainSession.id, 'msg-1');
if (preview.hasIrreversibleActions) {
  console.warn('Irreversible actions detected:', preview.irreversibleDetails);
}
const result = await mwm.withdrawMessageAsync(mainSession.id, 'msg-1');
console.log('Restored files:', result.restoredFiles);

// 8. Session lease
const leaseMgr = SessionLeaseManager.getInstance();
const lease = leaseMgr.acquire(mainSession.id);
// ... run agent loop ...
leaseMgr.release(mainSession.id);

// 9. Archive when done
await sm.archiveSession(mainSession.id);

// 10. Garbage collect old sessions
const store = SessionStore.getInstance();
const archived = await store.garbageCollect();
```

---

## Key Constraints

1. **Sub-session workspace inheritance**: `createSubSession()` copies the parent's
   workspace. If the parent workspace is later changed, existing sub-sessions are
   re-synced on the next duplicate check.
2. **Per-session sequential lock**: all mutations on a session (`appendMessage`,
   `setTitle`, `setWorkspace`, `rewriteHistory`, `archiveSession`) are serialized.
   No two mutations run concurrently on the same session.
3. **One AgentLoop per session**: enforced by `AgentRuntime._activeLoops`. A
   second `processMessage()` call queues the message as a soft interrupt instead
   of spawning a second loop.
4. **No global concurrency limit**: `SessionLeaseManager.acquire()` always
   succeeds. The system trusts `_activeLoops` for per-session gating.
5. **JSONL sharding**: shards rotate at 10,000 lines or 10 MB. Archived shards
   are gzip-compressed after 30 days. Session recovery reads both `.jsonl` and
   `.jsonl.gz` files transparently.
6. **File history snapshots**: max `FILE_HISTORY_MAX_SNAPSHOTS` per session.
   Older snapshots and their orphaned backup files are pruned automatically.
7. **Message withdrawal**: file rollback is best-effort. Irreversible actions
   (git push, npm publish, etc.) are detected and reported but not reversed.
8. **Sub-session deduplication**: `createSubSession()` returns the existing
   active sub-session for the same `(parentSessionId, agentId)` pair instead of
   creating a duplicate.
