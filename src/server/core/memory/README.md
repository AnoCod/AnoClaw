# Memory System

Persistent agent and team memory with search, auto-extraction, and progressive disclosure. Uses SQLite (v2 primary) with filesystem fallback for backup/degradation. Integrates with PromptAssembler for memory injection into system prompts.

## Public API

### MemoryManager (Singleton)

```ts
import { MemoryManager } from './MemoryManager.js';
const mm = MemoryManager.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `search(agentId, scope, query, sessionId?, subScope?, fuzzy?)` | `agentId: string`, `scope: MemoryScope`, `query: string`, `sessionId?: string`, `subScope?: 'team' \| 'personal'`, `fuzzy?: boolean` | `Promise<MemoryEntry[]>` | Search memories by query within a scope. Empty query returns all. |
| `searchAll(agentId, query)` | `agentId: string`, `query: string` | `Promise<MemoryEntry[]>` | Search across team + agent scopes |
| `searchAllScopes(agentId, query, sessionId?)` | `agentId: string`, `query: string`, `sessionId?: string` | `Promise<MemoryEntry[]>` | Search all scopes: team + agent + session |
| `save(agentId, scope, entry, sessionId?)` | `agentId: string`, `scope: MemoryScope`, `entry: MemoryEntry`, `sessionId?: string` | `Promise<void>` | Save a memory entry. Invalidates prompt cache for the agent. |
| `saveFromParams(agentId, params)` | `agentId: string`, `params: { scope, type, name, content, description? }` | `Promise<MemoryEntry>` | Save from raw tool parameters (used by MemorySaveTool) |
| `remove(agentId, scope, name, sessionId?, subScope?)` | `agentId: string`, `scope: MemoryScope`, `name: string`, `sessionId?: string`, `subScope?: 'team' \| 'personal'` | `Promise<boolean>` | Remove a memory by name. Returns true if found. |
| `autoExtract(agentId, messages)` | `agentId: string`, `messages: Array<{ role, content }>` | `Promise<number>` | Scan assistant messages for patterns like "remember:", "learned:", "decided:", "know that:" and auto-save |
| `getRecentMemories(scope, targetId, limit?)` | `scope: string`, `targetId: string`, `limit?: number` | `MemoryEntry[]` | Synchronous — returns cached recent memories for prompt injection |
| `loadIndexContent(agentId, scope, agentName?, sessionId?, subScope?)` | `agentId: string`, `scope: MemoryScope`, `agentName?: string`, `sessionId?: string`, `subScope?: 'team' \| 'personal'` | `Promise<string>` | Load MEMORY.md index content |
| `loadIndexLinks(agentId, scope, sessionId?)` | `agentId: string`, `scope: MemoryScope`, `sessionId?: string` | `Promise<Array<{ name, file, description }>>` | Parse MEMORY.md into structured link entries |
| `setExtensionPoints(extPoints)` | `extPoints: ExtensionPointRegistry` | `void` | Inject plugin memory store override |

### MemoryEntry

```ts
interface MemoryEntry {
  name: string;           // Short identifier (filename-safe)
  type: MemoryType;       // User | Feedback | Project | Reference
  description: string;    // One-line summary
  content: string;        // Full Markdown body
  scope: MemoryScope;     // Team | Agent | Session
  sessionId?: string;     // For Session scope
  subScope?: 'team' | 'personal';
  updatedAt?: number;     // File mtime
  category?: MemoryCategory; // v2: Episodic | Semantic | Procedural | UserProfile
}
```

### Enums

```ts
enum MemoryScope { Team = 'team', Agent = 'agent', Session = 'session' }
enum MemoryType { User = 'user', Feedback = 'feedback', Project = 'project', Reference = 'reference' }
enum MemoryCategory { Episodic = 'episodic', Semantic = 'semantic', Procedural = 'procedural', UserProfile = 'user_profile' }
```

## Architecture (v2)

```
┌─────────────────────────────────────────────────┐
│                 MemoryManager                     │
│         (search / save / remove / extract)        │
├─────────────────────────────────────────────────┤
│  Primary: SQLite (MemoryDatabase)                 │
│  └─ Full-text search + embedding vectors          │
│                                                   │
│  Fallback: Filesystem (.md files + MEMORY.md)      │
│  └─ Auto-migrates to SQLite on first access       │
├─────────────────────────────────────────────────┤
│  EmbeddingService  │  MemorySearchScorer          │
│  (vector generation)│  (BM25 + vector + RRF)      │
├─────────────────────────────────────────────────┤
│  MemoryLifecycle   │  MemorySynonyms              │
│  (session close)   │  (cross-language expansion)  │
└─────────────────────────────────────────────────┘
```

## Four-Layer Classification

| Category | Maps from | Meaning |
|----------|-----------|---------|
| **Episodic** | Feedback | User corrections, guidance, specific interactions |
| **Semantic** | Project | Project facts, decisions, milestones, status |
| **Procedural** | Reference | Pointers to external docs, references, how-tos |
| **UserProfile** | User | User preferences, role, knowledge level |

## Progressive Disclosure

Memory injection follows a two-tier model:

1. **MemorySection (index)** — injected into the system prompt. Shows recent memory names + descriptions only. Lightweight, always present.
2. **memory_recall (detail)** — the agent calls the recall tool to load full content. On-demand, deep.

## Hybrid Search

Memory search uses a multi-strategy approach via `MemorySearchScorer`:

- **BM25** — keyword-based, fast exact matching
- **Vector search** — semantic similarity via embeddings (optional, fire-and-forget)
- **RRF fusion** — Reciprocal Rank Fusion combines results
- **Fuse.js fallback** — when no query scoring needed
- **Synonym expansion** — cross-language synonyms via `MemorySynonyms`

## Lifecycle

`MemoryLifecycle.runSessionCloseLifecycle()` is called when `AgentRuntime` emits `loop:completed`:

1. Run `autoExtract()` on the last N messages
2. Tag session with memory-derived labels
3. Flush any pending writes

## Sub-Modules

| Module | README | Purpose |
|--------|--------|---------|
| `embedding/` | [README](embedding/README.md) | Vector embedding generation (all-MiniLM-L6-v2) |
| `storage/` | [README](storage/README.md) | SQLite database + schema + migrations |
| `lifecycle/` | [README](lifecycle/README.md) | Session-close lifecycle hooks |

## Dependencies

### Called by
- `MemorySaveTool` / `MemorySearchTool` / `MemoryDeleteTool` — agent-facing tools
- `MemoryRoutes` — HTTP API for memory CRUD
- `MemorySection` (prompt) — injects `getRecentMemories()` into system prompt
- `AgentRuntime` → `MemoryLifecycle` — session-close auto-extraction
- `PluginHostManager` — injects ExtensionPoints, provides `memory.*` RPC methods

### Depends on
- `MemoryDatabase` (SQLite) — primary storage
- `MemoryStore` — filesystem read/write + index management
- `EmbeddingService` — optional vector generation
- `MemorySearchScorer` — fuzzy + semantic search scoring
- `MemorySynonyms` — cross-language expansion
- `PromptAssembler` — called to invalidate cache on write
- `ExtensionPoints` — plugin memory store override

## Constraints

- Session scope requires `sessionId` — throws if missing
- Memory names are filename-safe (sanitized, max 80 chars)
- Content auto-truncated to 200 chars in auto-extraction
- File paths checked for traversal safety
- `_recentCache` capped at 50 entries to prevent unbounded growth
- Embedding generation is fire-and-forget — never blocks writes
