# Prompt System

Assembles the system prompt sent to the LLM before every API call. 20 sections combined into one prompt, sorted by priority, with two-level caching (global + per-session).

## Public API

### PromptAssembler (Singleton)

```ts
import { PromptAssembler } from './PromptAssembler.js';
const pa = PromptAssembler.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `buildEffectivePrompt(agentId, sessionId, override?)` | `agentId: string`, `sessionId: string`, `override?: PromptOverride` | `string` | Build the full system prompt. Priority chain: ExtensionPoints override → user override → static zone → dynamic zone → agent definition → CustomCLI |
| `invalidateCache(scope, agentId?, sessionId?)` | `scope: CacheScope`, `agentId?: string`, `sessionId?: string` | `void` | Invalidate cache at Global/Agent/Session scope |
| `clearAllCaches()` | — | `void` | Nuke entire cache |
| `getSection(name)` | `name: string` | `SystemPromptSection \| undefined` | Look up a registered section by name |
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

## 20 Sections (Priority Order)

| # | Section | Priority | Zone | Description |
|---|---------|----------|------|-------------|
| 1 | SystemRulesSection | 10 | static | Core identity, role prompt, org structure |
| 2 | DocsSection | 15 | static | Reference doc injection |
| 3 | PluginDevSection | 18 | static | Plugin development guidelines |
| 4 | TaskExecutionSection | 20 | static | Task execution discipline |
| 5 | ActionsSection | 22 | static | Available actions/behaviors |
| 6 | ToolUsageSection | 25 | static | Tool usage rules |
| 7 | OutputEfficiencySection | 28 | static | Output efficiency rules |
| 8 | OrgContextSection | 30 | dynamic | Org tree + agent relationships |
| 9 | ActiveTaskSection | 32 | dynamic | Current active tasks |
| 10 | UserAwarenessSection | 35 | dynamic | User context awareness |
| 11 | EditorContextSection | 38 | dynamic | Editor/file state |
| 12 | SessionGuidanceSection | 40 | dynamic | Session-level guidance |
| 13 | DelegationContextSection | 45 | dynamic | Delegation rules + state |
| 14 | MemorySection | 50 | dynamic | Injected memories |
| 15 | EnvironmentSection | 55 | dynamic | Platform, OS, shell info |
| 16 | LanguageSection | 58 | dynamic | Response language preference |
| 17 | ToolPromptSection | 60 | dynamic | Tool-specific prompt instructions |
| 18 | TokenBudgetSection | 65 | dynamic | Token budget awareness |
| 19 | ToolsSection | 70 | dynamic | Available tool list |
| 20 | SkillsSection | 80 | dynamic | Loaded skill list |
| 21 | PermissionModeSection | 90 | dynamic | Permission/approval mode |

## Priority Chain (buildEffectivePrompt)

```
Priority 0: Plugin Override (ExtensionPoints.promptAssembler)
Priority 1: User Override (complete replacement via API)
→ Static Zone (global cache)
→ BOUNDARY_MARKER
→ Dynamic Zone (per-session cache)
→ Priority 2: Agent Definition (role prompt + agent.agentPrompt)
→ Priority 3: CustomCLI (runtime-injected instructions)
```

## Caching Strategy

- **Static zone**: One key per section (`global:<sectionName>`). Cached forever until explicit `invalidateGlobal()`. Shared across all agents/sessions.
- **Dynamic zone**: Per-session keys (`<agentId>:<sessionId>:<sectionName>`). Auto-invalidated on:
  - `/clear` command → `onClear()` busts that session's dynamic zone
  - Memory write → `onMemoryWritten()` busts only the Memory section
  - Session end → `invalidateSession()`
- **cacheBreak**: A section with `cacheBreak: true` recomputes on every request (never cached). Used for time-sensitive sections.

## Dependencies

### Called by
- `AgentLoopLLM` — calls `buildEffectivePrompt()` before every LLM API call
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
  name: 'Xxx',
  type: 'dynamic' as const,
  priority: 42,
};

export function createXxxSection(): SystemPromptSection {
  return {
    name: sectionMeta.name,
    cacheBreak: false,
    compute: (ctx) => {
      // Return section content as string
      return `## Xxx\nYour section content here.`;
    },
  };
}
```

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
