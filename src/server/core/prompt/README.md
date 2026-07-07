# Prompt System

Assembles the system prompt sent to the LLM before every API call. 21 sections are combined into a provider-cache-aware layout: stable global/agent/capability content first, volatile session/run state last. Local section caching remains two-level (global + per-session).

## Public API

### PromptAssembler (Singleton)

```ts
import { PromptAssembler } from './PromptAssembler.js';
const pa = PromptAssembler.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `buildEffectivePrompt(agentId, sessionId, override?, buildContext?)` | `agentId: string`, `sessionId: string`, `override?: PromptOverride`, `buildContext?: PromptBuildContext` | `string` | Build the full system prompt. Priority chain: ExtensionPoints override -> user override -> cacheable prefix -> BOUNDARY_MARKER -> volatile suffix |
| `analyzePromptLayout(agentId, sessionId, buildContext?)` | `agentId: string`, `sessionId: string`, `buildContext?: PromptBuildContext` | `PromptLayoutStats` | Estimate total tokens, provider-cacheable prefix tokens, volatile suffix tokens, and prefix ratio for diagnostics |
| `analyzePromptText(prompt)` | `prompt: string` | `PromptLayoutStats` | Estimate cache layout from an already-built prompt without recomputing sections |
| `invalidateCache(scope, agentId?, sessionId?)` | `scope: CacheScope`, `agentId?: string`, `sessionId?: string` | `void` | Invalidate cache at Global/Agent/Session scope |
| `clearAllCaches()` | — | `void` | Nuke entire cache |
| `registerSection(section, zone?)` | `section: SystemPromptSection`, `zone: 'static' \| 'dynamic'` | `void` | Register a new section dynamically |
| `setCustomCLI(instructions)` | `instructions: string \| null` | `void` | Inject runtime CLI instructions (Priority 2) |
| `setExtensionPoints(extPoints)` | `extPoints: ExtensionPointRegistry` | `void` | Inject plugin override registry |
| `onMemoryWritten(agentId)` | `agentId: string` | `void` | Invalidate Memory section cache for agent |
| `onClear(agentId, sessionId)` | `agentId: string`, `sessionId: string` | `void` | Clear dynamic cache for a session |
| `cacheStats` | — | `{ global: number; session: number }` | Diagnostic cache entry counts |
| `sectionNames` | — | `string[]` | All registered section names |

### PromptSection Interface

```ts
interface SystemPromptSection {
  name: string;                    // Unique name, used as cache key
  compute: (ctx: PromptContext) => string;  // Returns section text
  cacheBreak: boolean;             // true = recompute every request
}

interface PromptContext {
  agentId: string;
  sessionId: string;
  permissionMode?: string;
  effort?: string;
  hideUserInteractionTools?: boolean;
}
```

### PromptCache

```ts
class PromptCache {
  set(key, value, scope): void;
  get(key): string | undefined;
  has(key): boolean;
  invalidateGlobal(): void;       // Clear static zone
  invalidateAgent(agentId): void; // Clear everything for an agent
  invalidateSession(sessionId): void;
  invalidateAll(): void;
  onMemoryWritten(agentId): void; // Smart invalidation — only Memory section
  onClear(agentId, sessionId): void;
}
```

### CacheScope Enum

```ts
enum CacheScope {
  Global = 'global',   // Static zone — shared across all agents/sessions
  Agent = 'agent',     // Per-agent
  Session = 'session', // Per-session
}
```

## 21 Sections (Priority Order)

| # | Section | Priority | Zone | Description |
|---|---------|----------|------|-------------|
| 1 | DocsSection | 10 | static | Reference doc injection |
| 2 | SystemRulesSection | 20 | static | Core identity, role prompt, org structure |
| 3 | PluginDevSection | 20 | static | Plugin development guidelines |
| 4 | TaskExecutionSection | 30 | static | Task execution discipline |
| 5 | ActionsSection | 40 | static | Available actions/behaviors |
| 6 | ToolUsageSection | 50 | static | Tool usage rules |
| 7 | OutputEfficiencySection | 70 | static | Output efficiency rules |
| 8 | OrgContextSection | 80 | dynamic | Org tree + agent relationships |
| 9 | UserAwarenessSection | 82 | dynamic | User context awareness |
| 10 | EditorContextSection | 83 | dynamic | Editor/file state |
| 11 | ActiveTaskSection | 84 | dynamic | Current active tasks |
| 12 | SessionGuidanceSection | 90 | dynamic | Session-level guidance |
| 13 | DelegationContextSection | 100 | dynamic | Delegation rules + state |
| 14 | MemorySection | 110 | dynamic | Injected memories |
| 15 | EnvironmentSection | 120 | dynamic | Platform, OS, shell info |
| 16 | LanguageSection | 130 | static | Response language preference |
| 17 | TokenBudgetSection | 150 | dynamic | Token budget awareness |
| 18 | ToolPromptSection | 155 | dynamic | Tool-specific prompt instructions |
| 19 | ToolsSection | 160 | dynamic | Available tool list |
| 20 | SkillsSection | 170 | dynamic | Loaded skill list |
| 21 | PermissionModeSection | 190 | dynamic | Permission/approval mode |

Sections with matching priority (e.g. SystemRules + PluginDev both at 20) are ordered by their position in `registerAllSections.ts`. Lower priority = appears earlier inside the same layout group. Layout groups are more important than numeric priority across groups.

**Provider cache layout**: Static sections, agent role/custom prompt, CustomCLI, and stable capability sections (`ToolPrompt`, `Tools`, `Skills`) appear before `BOUNDARY_MARKER`. Volatile sections such as session guidance, org/task/editor context, memory, environment, token budget, and permission mode appear after the marker.

## Priority Chain (buildEffectivePrompt)

```
Priority 0: Plugin Override (ExtensionPoints.promptAssembler)
Priority 1: User Override (complete replacement via API)
-> Cacheable Prefix
   -> Static Zone (global local cache)
   -> Agent Definition (role prompt + agent.agentPrompt)
   -> CustomCLI (runtime-injected instructions)
   -> Capability Zone (ToolPrompt + Tools + Skills)
-> BOUNDARY_MARKER
-> Volatile Suffix
   -> Remaining dynamic sections (per-session/run local cache where safe)
```

## Caching Strategy

- **Static zone**: One key per section (`global:<sectionName>`). Cached forever until explicit `invalidateGlobal()`. Shared across all agents/sessions.
- **Capability zone**: Dynamic sections that are usually stable for a given agent/run (`ToolPrompt`, `Tools`, `Skills`) are placed before `BOUNDARY_MARKER` to improve provider-side prefix-cache hits. Sections may still recompute locally when needed.
- **Volatile suffix**: Dynamic sections that change with the session, workspace, memory, task state, token usage, or permission mode are placed after `BOUNDARY_MARKER` so they do not spoil the stable prefix.
- **Dynamic local cache**: Per-session keys (`<agentId>:<sessionId>:<sectionName>`). Auto-invalidated on:
  - `/clear` command → `onClear()` busts that session's dynamic zone
  - Memory write → `onMemoryWritten()` busts only the Memory section
  - Session end → `invalidateSession()`
- **cacheBreak**: A section with `cacheBreak: true` recomputes on every request (never cached). Used for time-sensitive sections.
- **Diagnostics**: `analyzePromptLayout()` and the `Prompt assembled` debug log expose estimated provider-cacheable prefix tokens.

## Dependencies

### Called by
- `AgentLoop` — refreshes `buildEffectivePrompt()` before every LLM turn and passes run-scoped mode/effort/tool visibility context
- `PromptRoutes` — HTTP routes for prompt diagnostics
- `PluginHostManager` — injects `ExtensionPoints` at startup
- `MemoryManager` — calls `onMemoryWritten()` on save/remove
- `ClearCommand` — calls `onClear()` on `/clear`
- `SkillManager` — calls `clearAllCaches()` on reload

### Depends on
- `AgentRegistry` — reads agent definition for Priority 2 injection
- `MemoryManager` (via MemorySection) — injects recent memories
- `SkillManager` (via SkillsSection) — injects loaded skill list
- `ExtensionPoints` — checks for plugin prompt overrides

## Adding a New Section

1. Create `src/server/core/prompt/sections/XxxSection.ts`:

```ts
import type { SystemPromptSection } from '../PromptSection.js';

export const sectionMeta = {
  name: 'xxx',         // lowercase stable identifier (used for metadata, not cache key)
  type: 'dynamic' as const,
  priority: 42,
};

export function createXxxSection(): SystemPromptSection {
  return {
    name: 'Xxx',       // PascalCase display name (used as cache key suffix)
    cacheBreak: false,
    compute: (ctx) => {
      return `## Xxx\nYour section content here.`;
    },
  };
}
```

**Naming convention**: `sectionMeta.name` is a lowercase stable identifier for metadata. The section object's `name` field is PascalCase and is what gets used in cache keys (`agentId:sessionId:<sectionObjectName>`). They typically match (e.g. `'docs'` / `'Docs'`) but are separate fields with separate purposes.

2. Register in `src/server/core/prompt/sections/registerAllSections.ts`:
   - Import `sectionMeta` and `createXxxSection`
   - Add to the `SECTIONS` array

3. Rebuild: `npm run build`

## Constraints

- **Section content must be English** — this is LLM-facing text
- **Lower priority = appears earlier** in the prompt
- **Static sections**: content that never changes per session (rules, docs, core identity)
- **Dynamic sections**: content that varies per session (memories, tasks, environment)
- **Never delete existing sections** — only add or modify
- `compute()` receives `PromptContext` but may call any service to build content
- Max file size: 500 lines per section file

## Events

| Event | When |
|-------|------|
| `promptBuilt` | After `buildEffectivePrompt()` completes |
| `cacheInvalidated` | After any cache invalidation |
