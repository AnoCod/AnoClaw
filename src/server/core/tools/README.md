# Tool Framework — `src/server/core/tools/`

The Tool Framework is the execution backbone for built-in and plugin tools. Every tool call flows through a standardized 5-stage pipeline: validation, security, execution, retry, and normalization. Tools are auto-discovered from the `builtin/` directory — no manual registration.

---

## Module Overview

| File | Role |
|---|---|
| `Tool.ts` | Abstract base class — all tools extend this |
| `ToolRegistry.ts` | Singleton registry — register, lookup, list, execute |
| `ToolPipeline.ts` | 5-stage execution pipeline applied to every tool call |
| `ToolResult.ts` | Pure factory functions for success/error result objects |

---

## 1. Tool (abstract class)

**Extends**: `EventEmitter`

Every tool inherits from `Tool`. Subclasses must implement 4 abstract methods and may override ~20 hooks.

### Static Metadata

```ts
static category: string = 'Uncategorized';  // Grouping for UI and system prompts
static toolDescription: string = '';         // One-line summary for listings
```

### Abstract (must implement)

| Method | Returns | Purpose |
|---|---|---|
| `name()` | `string` | Unique tool name sent to the LLM |
| `description()` | `string` | Human-readable description for the LLM system prompt |
| `parametersSchema()` | `Record<string, unknown>` | JSON Schema for tool parameters (OpenAI/Anthropic format) |
| `execute(params, ctx)` | `Promise<ToolResult>` | Core tool logic |

### Optional Hooks (override as needed)

| Hook | Default | Purpose |
|---|---|---|
| `prompt()` | `''` | Usage guidance injected into the system prompt |
| `displayName()` | derived from `name()` | User-facing display name |
| `riskLevel()` | `RiskLevel.Safe` | Permission gating level |
| `requiresConfirmation(ctx)` | `true` for Critical/High | Whether user must approve before execution |
| `interruptBehavior()` | `InterruptBehavior.Cancel` | What happens on abort (Cancel vs Block) |
| `isAsync()` | `false` | Long-running tool flag |
| `defaultTimeoutMs()` | `30000` | Stall detection timeout |
| `isReadOnly()` | `false` | Safe in read-only mode |
| `isConcurrencySafe()` | `false` | Safe for parallel execution |
| `minRole()` | `'SubAgent'` | Minimum agent role required |
| `maxRetries()` | `3` | Retry count for transient failures (0 = no retry) |
| `outputLimit()` | `10000` | Max chars before pipeline truncation |
| `shouldDefer()` | `false` | Tool does not consume a model turn |
| `requiresUserInteraction()` | `false` | Pause agent loop after tool returns |
| `userFacingName()` | `this.name()` | Label shown in UI |
| `getToolUseSummary(input)` | `null` | Compact activity summary (≤50 chars) |
| `getActivityDescription(input)` | `null` | Present-tense description like "Reading file..." |

### LLM Format Conversion

```ts
toOpenAIFunction(): Record<string, unknown>   // → { type: 'function', function: {...} }
toAnthropicTool(): Record<string, unknown>    // → { name, description, input_schema }
```

### Internal

```ts
_executeWithEvents(params, ctx, toolCallId?): Promise<ToolResult>
```
Wraps `execute()` with event emission (`ToolEvents.Executed`, `ToolEvents.Error`) and timing. Called by `ToolRegistry`, not directly.

---

## 2. ToolRegistry (Singleton)

**Extends**: `EventEmitter`

Central registry for all tools. Auto-populated at startup by `ToolRegistrar` scanning `builtin/`.

### Singleton Access

```ts
const registry = ToolRegistry.getInstance();
ToolRegistry.resetInstance();  // tests only
```

### Register / Deregister

```ts
registerTool(tool: Tool, group?: string): void    // Emits 'toolRegistered'
deregisterTool(name: string): void                // Removes tool + group entry
clear(): void                                     // Wipes all tools
```

### Lookup

```ts
tool(name: string): Tool | undefined
hasTool(name: string): boolean
```

### Listing

```ts
allTools(): Tool[]
allToolNames(): string[]
toolsForAgent(allowedTools: string[]): Tool[]     // Filter by allowlist
toolsByGroup(group: string): Tool[]               // Filter by category
groups(): string[]                                // All group names
allToolsWithMeta(): { name, description, group, displayName }[]
```

### Queries

```ts
isReadOnly(name: string): boolean
isConcurrencySafe(name: string): boolean
```

### LLM Format Export

```ts
toOpenAIFunctions(allowedTools?: string[]): unknown[]
toAnthropicTools(allowedTools?: string[]): unknown[]
```

### Execute

```ts
execute(toolName: string, params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult>
```

The main entry point for tool execution. Internally:
1. Checks `extensionPoints.get('toolExecutor')` for plugin overrides
2. Looks up the tool (returns error if not found)
3. Checks role permission via `canUseTool(ctx.callerRole, tool.minRole())`
4. Delegates to `ToolPipeline.run(tool, params, ctx, toolCallId)`
5. Logs result and records to `ToolProfiler`
6. Emits `tool:execution_started` / `tool:execution_completed` via `TypedEventBus`

### DI (Dependency Injection)

```ts
setLogger(logger: ILogger): void
setProfiler(profiler: ToolProfilerLike): void
```

---

## 3. ToolPipeline — 5-Stage Execution

Every tool call passes through all five stages. Any stage can short-circuit with an error `ToolResult`.

```
params, ctx
     │
     ▼
┌──────────────────────────────────────────────┐
│ Stage 0: validateParams()                    │
│ Checks required fields, types, enum values   │
│ based on tool.parametersSchema()             │
│ Short-circuits on: missing required, wrong   │
│ type, invalid enum                           │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│ Stage 1: securityCheck()                     │
│ - Blocks Critical-risk tools without         │
│   user confirmation                          │
│ - Blocks non-read-only tools in read-only    │
│   mode                                       │
│ Short-circuits on: permission denied         │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│ Stage 2: execute()                           │
│ Calls tool._executeWithEvents(params, ctx)   │
│ which wraps tool.execute() with event        │
│ emission and timing                          │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│ Stage 3: retry()                     │
│ Only on transient errors that match          │
│ RETRYABLE_PATTERNS (network, timeout, 5xx)   │
│ NOT on USER_VISIBLE_PATTERNS (ENOENT, EACCES)│
│ Exponential backoff: 1s, 2s, 4s... up to 5s │
│ Uses tool.maxRetries() (default: 3)          │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│ Stage 4: normalizeOutput()                   │
│ Truncates content exceeding outputLimit()    │
│ (default 10000, Read uses 80000)             │
│ Format: head 500 chars + "[N truncated]"     │
│ + tail 500 chars                             │
│ Sets result.wasTruncated = true              │
│ Skipped for error results                    │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
                 ToolResult
```

### Retry Pattern Classification

**Retryable** (transient — will retry):
- Network errors: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`
- Connection strings: `network`, `connection`, `timeout`, `fetch.*failed`, `abort`, `socket`
- Rate limits: `rate.?limit`, `too many requests`, `busy`, `overloaded`, `throttled`
- Server errors: `5\d\d`, `server.*error`, `internal.*error`, `bad gateway`, `service.*unavailable`

**Not retryable** (shown to LLM immediately):
- File errors: `ENOENT`, `no such file`, `not found`
- Permission: `EACCES`, `permission denied`, `access denied`
- User errors: `invalid`, `bad request`, `malformed`

### Configuration

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_OUTPUT_CHARS` | 10000 | Fallback output limit |
| `TRUNCATE_HEAD_TAIL` | 500 | Chars kept from head and tail when truncating |
| Exponential backoff | `min(2^attempt × 500, 5000)` ms | Retry delay |

### Static API

```ts
ToolPipeline.run(tool, params, ctx, toolCallId): Promise<ToolResult>
```

Each stage is also exposed as a static method for testing:

```ts
ToolPipeline.validateParams(tool, params): ToolResult | null
ToolPipeline.securityCheck(tool, params, ctx): ToolResult | null
ToolPipeline.execute(tool, params, ctx, toolCallId): Promise<ToolResult>
ToolPipeline.retry(tool, params, ctx, originalResult): Promise<ToolResult>
ToolPipeline.normalizeOutput(result, tool): ToolResult
```

---

## 4. ToolResult

Factory functions for creating standardized tool result objects.

### Interface

```ts
interface ToolResult {
  toolCallId: string;
  success: boolean;
  content: string;
  structured?: Record<string, unknown>;
  errorMessage?: string;
  tokensUsed: number;
  startedAt: number;       // Date.now()
  finishedAt: number;      // Date.now()
  durationMs: number;
  wasTruncated: boolean;
}
```

### Factory Functions

```ts
makeResult(content: string, opts?: MakeResultOptions): ToolResult
```
Creates a successful result. `tokensUsed` is estimated as `ceil(content.length / 4)` unless explicitly provided.

```ts
makeError(errorMessage: string, opts?: MakeResultOptions): ToolResult
```
Creates a failure result. `success: false`, `tokensUsed: 0`.

```ts
toolResultFromJson(json: Record<string, unknown>): ToolResult
```
Hydrates a ToolResult from a plain object (e.g., from transcript JSONL). Missing fields get safe defaults.

### MakeResultOptions

```ts
interface MakeResultOptions {
  toolCallId?: string;
  tokensUsed?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  structured?: Record<string, unknown>;
  wasTruncated?: boolean;
}
```

---

## 5. ExecutionContext

```ts
interface ExecutionContext {
  sessionId: string;        // Current session identifier
  agentId: string;          // Calling agent identifier
  workspace: string;        // Agent's workspace directory
  userConfirmed: boolean;   // Whether user approved this tool call
  callerRole?: AgentRole;   // Role for permission checks ('MainAgent' | 'Manager' | 'Member' | 'SubAgent')
  signal?: AbortSignal;     // From InterruptController — tools should abort when signaled
}
```

---

## 6. RiskLevel & canUseTool()

### RiskLevel Enum

```ts
enum RiskLevel {
  Safe     = 'Safe',       // No side effects
  Low      = 'Low',        // Minor side effects
  Medium   = 'Medium',     // Moderate risk
  High     = 'High',       // Requires user confirmation (unless already given)
  Critical = 'Critical',   // Always requires user confirmation
}
```

### InterruptBehavior Enum

```ts
enum InterruptBehavior {
  Cancel = 'cancel',  // Result discarded; safe to retry
  Block  = 'block',   // Must NOT be re-run (partial destructive side effects)
}
```

### canUseTool()

```ts
function canUseTool(callerRole: string | undefined, minRequiredRole: string): boolean
```

Checks whether the caller's agent role meets the tool's minimum role requirement. Role hierarchy (lower number = higher privilege):

```
MainAgent (0) → Manager (1) → Member (2) → SubAgent (3)
```

A caller at level N can use any tool requiring level ≥ N. Returns `true` if `callerRole` is undefined (backward compatibility).

### Role Assignments (builtin tools)

| Role | Tools |
|---|---|
| `MainAgent` (0) only | `AskUserQuestion` |
| `Manager` (1)+ | `HireEmployee`, `TaskAssign`, `UpdateOrg` |
| `Member` (2)+ | `SubAgentSpawn` |
| `SubAgent` (3)+ | All other tools (the default) |

---

## 7. Call Chain

```
AgentLoop (ReAct)
  │
  ├─► ToolRegistry.execute(toolName, params, ctx)
  │     │
  │     ├─► Plugin overrides? → extensionPoints.get('toolExecutor')
  │     ├─► Tool lookup: this.tool(toolName)
  │     ├─► Role check: canUseTool(ctx.callerRole, tool.minRole())
  │     │
  │     └─► ToolPipeline.run(tool, params, ctx, toolCallId)
  │           │
  │           ├─► Stage 0: validateParams()     — schema check
  │           ├─► Stage 1: securityCheck()      — risk + read-only
  │           ├─► Stage 2: execute()            — tool._executeWithEvents()
  │           │     └─► tool.execute(params, ctx)
  │           ├─► Stage 3: retry()              — transient errors only
  │           └─► Stage 4: normalizeOutput()    — truncation
  │
  └─► Result back to AgentLoop → LLM or user
```

### Who Calls What

| Caller | Calls |
|---|---|
| `AgentLoop` | `ToolRegistry.execute()` |
| `ToolRegistrar` (startup) | `ToolRegistry.registerTool()` for each builtin file |
| `PluginHost` | `ToolRegistry.registerTool()` for plugin tools |
| `Gateway / ToolHandlers` | `ToolRegistry.list()`, `ToolRegistry.allToolsWithMeta()` |
| `PromptAssembler` | `ToolRegistry.toAnthropicTools()` / `toOpenAIFunctions()` |
| `AgentRuntime` | `ToolRegistry.toolsForAgent()` for agent tool allowlists |

---

## 8. Adding a New Tool

### Step 1: Create the file

```ts
// src/server/core/tools/builtin/EchoTool.ts
import { Tool } from '../Tool.js';
import { RiskLevel } from '../../../shared/types/tool.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';

export class EchoTool extends Tool {
  static category = 'File & Code';
  static toolDescription = 'Echoes back the input message.';

  name(): string {
    return 'Echo';
  }

  description(): string {
    return 'Returns the given message unchanged. Useful for testing.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back.',
        },
      },
      required: ['message'],
    };
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const message = params.message as string;
    return this.makeResult(`Echo: ${message}`);
  }
}
```

### Step 2: Rebuild

```bash
npm run build
```

The tool is auto-registered by `ToolRegistrar` which scans `builtin/` for `Tool` subclasses at startup. No manual import or registration step needed.

### Category Selection

Choose one of the 8 existing categories (or a new one — new categories auto-create):

| Category | Example Tools |
|---|---|
| `File & Code` | Bash, Read, Write, Edit, Glob, Grep, NotebookEdit |
| `Search & Web` | WebFetch, WebSearch |
| `Task Delegation` | TaskAssign, TaskList, AgentMessage, SubAgentSpawn |
| `Planning & Communication` | TodoWrite, Sleep, AskUserQuestion, EnterPlanMode |
| `Organization Management` | HireEmployee, ListEmployees, UpdateOrg |
| `Memory & Skills` | MemorySave, MemorySearch, Skill, SkillList |
| `Browser` | BrowserAgent |
| `System` | ApiCall, RunProgram, RestartServer |

---

## 9. Usage Examples

### Execute a tool programmatically

```ts
import { ToolRegistry } from './ToolRegistry.js';

const registry = ToolRegistry.getInstance();
const ctx: ExecutionContext = {
  sessionId: 'sess-001',
  agentId: 'agent-main',
  workspace: '/home/user/project',
  userConfirmed: false,
};

const result = await registry.execute('Read', {
  file_path: '/home/user/project/package.json',
}, ctx);

if (result.success) {
  console.log(result.content);       // file contents
  console.log(result.durationMs);    // execution time
} else {
  console.error(result.errorMessage);
}
```

### List tools available to an agent

```ts
const agentTools = registry.toolsForAgent([
  'Read', 'Write', 'Bash', 'Grep', 'Glob'
]);
// Returns Tool[] with only those 5 tools
```

### Get Anthropic-format tool definitions for the LLM

```ts
const anthropicTools = registry.toAnthropicTools(agentAllowedTools);
// → [{ name: 'Read', description: '...', input_schema: {...} }, ...]
```

### Create results inside a tool's execute()

```ts
// Success
return this.makeResult('Operation completed');

// Success with metadata
return this.makeResult('Done', {
  tokensUsed: 150,
  structured: { filesRead: 3, bytesTotal: 12000 },
});

// Error
return this.makeError('File not found', { toolCallId: 'read-123' });
```

### Check tool permissions

```ts
import { canUseTool } from './Tool.js';

if (!canUseTool(ctx.callerRole, tool.minRole())) {
  // Blocked — caller lacks permission
}
```

### Interrupt handling

```ts
async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
  // Long-running tool should check the abort signal
  for (const item of items) {
    if (ctx.signal?.aborted) {
      return this.makeError('Tool execution was interrupted');
    }
    await processItem(item);
  }
  return this.makeResult('All items processed');
}
```
