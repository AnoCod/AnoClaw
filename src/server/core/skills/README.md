# Skills System

Loads, parses, and matches Claude Code-compatible SKILL.md files from multiple sources. Provides semantic matching against user messages, conditional activation via file paths, and auto-generation from tool usage patterns.

## Public API

### SkillManager (Singleton)

```ts
import { SkillManager } from './SkillManager.js';
const sm = SkillManager.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `loadFromDirectory(dir, source?)` | `dir: string`, `source?: SkillSource` | `Promise<void>` | Recursively load SKILL.md files from a directory |
| `loadUserSkills()` | — | `Promise<void>` | Load skills from `~/.anoclaw/skills/` |
| `loadFromPlugin(pluginPath)` | `pluginPath: string` | `Promise<void>` | Load from a plugin's `skills/` subdirectory |
| `reloadAll()` | — | `Promise<void>` | Reload all previously loaded directories. Invalidates prompt cache. |
| `allSkills()` | — | `Skill[]` | All loaded skills, sorted by name |
| `allEnabledSkills()` | — | `Skill[]` | All skills not in the disabled set |
| `getSkill(name)` | `name: string` | `Skill \| undefined` | Look up a single skill |
| `matchingSkills(userMessage)` | `userMessage: string` | `Skill[]` | Find skills matching a user message (multi-tier scoring) |
| `skillsForAgent(agentId)` | `agentId: string` | `Skill[]` | Skills filtered by agent's enabled list |
| `loadSkillBody(name)` | `name: string` | `string \| null` | Get full markdown body of a skill |
| `createSkill(name, description, content, skillsDir?)` | `name: string`, `description: string`, `content: string`, `skillsDir?: string` | `Promise<void>` | Create a new SKILL.md on disk + register |
| `updateSkill(name, description, content)` | `name: string`, `description: string`, `content: string` | `Promise<void>` | Update an existing skill on disk |
| `deleteSkill(name)` | `name: string` | `Promise<void>` | Delete skill from disk + unregister |
| `toggleSkill(name, enabled)` | `name: string`, `enabled: boolean` | `Promise<void>` | Enable/disable a skill (persisted to JSON) |
| `isEnabled(name)` | `name: string` | `boolean` | Check if skill is enabled |
| `autoGenerateSkill(transcript, toolCalls?)` | `transcript: unknown[]`, `toolCalls?: Array<{ name, result? }>` | `Promise<string \| null>` | Auto-generate a SKILL.md from tool call patterns |
| `count` | — | `number` | Total loaded skill count |
| `skillSources()` | — | `Map<string, SkillSource>` | Map of skill name → source |

### Skill Class

```ts
class Skill {
  // Constructors
  static async fromMarkdown(filePath: string, source?: SkillSource): Promise<Skill>;
  static fromContent(content: string, virtualPath: string, source?: SkillSource): Skill;

  // Getters
  name(): string;
  description(): string;
  body(): string;                    // Full markdown body
  whenToUse(): string;               // Semantic matching description
  triggers(): string[];              // Keyword triggers
  paths(): string[];                 // Conditional activation globs
  requiredTools(): string[];         // Required tool names
  model(): string;                   // Preferred model
  effort(): string;                  // low | medium | high
  priority(): number;                // Loading priority
  source(): SkillSource;
  filePath(): string;
  context(): 'inline' | 'fork';
  agent(): string;                   // Bound agent name
  shell(): string;                   // bash | powershell
  userInvocable(): boolean;
  hasEmbeddedShell(): boolean;

  // Methods
  matchesScenario(userMessage: string): boolean;
  matchesPath(filePath: string): boolean;
  extractEmbeddedShell(): { cleanBody: string; commands: Array<{ placeholder, command }> };
}
```

### SkillParser

```ts
function parseSkillMarkdown(content: string, filePath: string): {
  frontmatter: Record<string, unknown>;
  body: string;
};

function validateSkillFrontmatter(fm: Record<string, unknown>): string[];
// Returns error strings; empty array = valid.
```

### SkillSource Enum

```ts
enum SkillSource {
  Project = 'project',   // Priority 4 (highest)
  User = 'user',         // Priority 3
  Plugin = 'plugin',     // Priority 2
  Builtin = 'builtin',   // Priority 1 (lowest, overridable)
}
```

### SkillFromTools

```ts
function generateSkillFromTools(
  transcript: unknown[],
  toolCalls?: Array<{ name: string; result?: string }>,
  projectSkillsDir?: string,
  onGenerated?: (skillName: string) => Promise<void>,
): Promise<string | null>;

function guessCategoryFromTools(toolNames: string[]): string;
function deriveSkillName(toolCalls: Array<{ name, result? }>): string | null;
function deriveDescription(toolCalls: Array<{ name, result? }>): string;
function deriveSteps(toolCalls: Array<{ name, result? }>): string;
function deriveTriggerKeywords(transcript: unknown[]): string[];
```

## Skill Definition Format

Skills are Markdown files with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does
when_to_use: "Use when the user asks about X or mentions Y"
triggers:
  - "keyword1"
  - "keyword2"
allowed-tools:
  - Read
  - Write
model: sonnet
effort: high
priority: 50
paths:
  - "src/**/*.ts"
version: "1.0.0"
context: inline
agent: MainAgent
shell: bash
user_invocable: true
---

# My Skill

Skill body in Markdown. Can include embedded shell: !`echo hello`
```

### Required fields: `name`, `description`
### Optional fields: `when_to_use`, `triggers`, `allowed-tools`, `model`, `effort`, `priority`, `paths`, `version`, `context`, `agent`, `shell`, `user_invocable`

## Multi-Source Loading

Skills load from 4 sources with priority-based override:

```
Project (skills/)  >  User (~/.anoclaw/skills/)  >  Plugin (plugin/skills/)  >  Builtin
```

If the same skill name exists in multiple sources, the higher-priority source wins.

## Matching Tiers

`matchingSkills()` uses 3-tier scoring:

| Tier | Strategy | Weight |
|------|----------|--------|
| 1 | Exact keyword trigger match | `length × 10` |
| 2 | `when_to_use` quoted phrase match | `length × 3` |
| 3 | Skill name substring (4+ chars) | `length × 0.5` |

## Conditional Activation

Skills with `paths` glob patterns are only active when files matching those patterns are present in the workspace. `Skill.matchesPath(filePath)` checks patterns like `src/**/*.ts`.

## Auto-Generation (SkillFromTools)

Triggered when a single turn exceeds 5 tool calls. The system:

1. Extracts tool call sequence
2. Derives a domain category (git-workflow, code-edit, browser-task, etc.)
3. Generates a structured SKILL.md with YAML frontmatter
4. Writes to `skills/auto-{domain}-{timestamp}/SKILL.md`
5. Reloads the skill registry

## Dependencies

### Called by
- `SkillsExtension` — loads project skills at startup
- `SkillsSection` (prompt) — injects loaded skill list
- `SkillRoutes` / `SkillExecuteRoute` — HTTP API
- `PluginHost` — loads plugin skills on activation
- `EvolutionManager` — auto-generates skills from patterns
- `AgentLoop` — calls `matchingSkills()` for conditional activation

### Depends on
- `SkillParser` — YAML frontmatter parsing + validation
- `SkillFromTools` — auto-generation from tool patterns
- `PromptAssembler` — cache invalidation on reload/create/delete
- `AgentRegistry` — agent-specific skill filtering

## Constraints

- Skill names are kebab-case, lowercase, no special chars
- YAML frontmatter is required — files without `---` delimiters fail to load
- Disabled skills persist to `data/disabled-skills.json`
- `reloadAll()` clears the entire skill map and reloads from all directories
- Flat `.md` files in skill directories are supported but deprecated (logged as warning)
- Auto-generated skills never overwrite existing manual skills
