# Built-in Tools — `src/server/core/tools/builtin/`

34 built-in tools organized into 8 categories. Tools are auto-registered by `ToolRegistrar` scanning this directory at startup — simply place a new `.ts` file here and rebuild.

---

## Module Overview

| File | Tool Name | Category | Risk | Min Role |
|---|---|---|---|---|
| `BashTool.ts` | `Bash` | File & Code | High/Critical | SubAgent |
| `ReadTool.ts` | `Read` | File & Code | Safe | SubAgent |
| `WriteTool.ts` | `Write` | File & Code | Medium | SubAgent |
| `EditTool.ts` | `Edit` | File & Code | Medium | SubAgent |
| `GlobTool.ts` | `Glob` | File & Code | Safe | SubAgent |
| `GrepTool.ts` | `Grep` | File & Code | Safe | SubAgent |
| `NotebookEditTool.ts` | `NotebookEdit` | File & Code | Medium | SubAgent |
| `WebFetchTool.ts` | `WebFetch` | Search & Web | Medium | SubAgent |
| `WebSearchTool.ts` | `WebSearch` | Search & Web | Low | SubAgent |
| `SleepTool.ts` | `Sleep` | Planning & Communication | Safe | SubAgent |
| `EnterPlanModeTool.ts` | `EnterPlanMode` | Planning & Communication | Safe | SubAgent |
| `ExitPlanModeTool.ts` | `ExitPlanMode` | Planning & Communication | Safe | SubAgent |
| `AskUserQuestionTool.ts` | `AskUserQuestion` | Planning & Communication | Safe | MainAgent |
| `TodoWriteTool.ts` | `TodoWrite` | Planning & Communication | Safe | SubAgent |
| `TaskAssignTool.ts` | `TaskAssign` | Task Delegation | Medium | Manager |
| `TaskListTool.ts` | `TaskList` | Task Delegation | Safe | SubAgent |
| `TaskOutputTool.ts` | `TaskOutput` | Task Delegation | Safe | SubAgent |
| `TaskStopTool.ts` | `TaskStop` | Task Delegation | Medium | SubAgent |
| `AgentMessageTool.ts` | `AgentMessage` | Task Delegation | Medium | SubAgent |
| `SubAgentSpawnTool.ts` | `SubAgentSpawn` | Task Delegation | Medium | Member |
| `SubAgentDeleteTool.ts` | `SubAgentDelete` | Task Delegation | Medium | SubAgent |
| `HireEmployeeTool.ts` | `HireEmployee` | Organization Management | High | Manager |
| `ListEmployeesTool.ts` | `ListEmployees` | Organization Management | Safe | SubAgent |
| `UpdateOrgTool.ts` | `UpdateOrg` | Organization Management | Medium | Manager |
| `MemorySaveTool.ts` | `memory_save` | Memory & Skills | Safe | SubAgent |
| `MemorySearchTool.ts` | `memory_search` | Memory & Skills | Safe | SubAgent |
| `MemoryDeleteTool.ts` | `memory_delete` | Memory & Skills | Safe | SubAgent |
| `MemoryRecallTool.ts` | `memory_recall` | Memory & Skills | Safe | SubAgent |
| `SkillTool.ts` | `Skill` | Memory & Skills | Safe | SubAgent |
| `SkillListTool.ts` | `SkillList` | Memory & Skills | Safe | SubAgent |
| `SkillInspectTool.ts` | `SkillInspect` | Memory & Skills | Safe | SubAgent |
| `BrowserAgentTool.ts` | `Browser` | Browser | Medium | SubAgent |
| `ApiCallTool.ts` | `ApiCall` | System | High | SubAgent |
| `RestartServerTool.ts` | `RestartServer` | System | High | SubAgent |

---

## 1. File & Code (7 tools)

### BashTool — `Bash`

Executes shell commands with confirmation, timeout, background-task, working-directory, and structured exit-status support.

| Property | Value |
|---|---|
| Risk | `High` → `Critical` (critical if command matches destructive patterns) |
| InterruptBehavior | `Block` for destructive commands, `Cancel` otherwise |
| Async | Yes (supports `run_in_background`) |
| Timeout | 30s default, configurable via `timeout` param |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | The shell command to execute |
| `description` | string | ✓ | Clear description of what the command does |
| `timeout` | number | | Max execution time in ms (max 600000) |
| `cwd` | string | | Working directory; relative paths resolve from workspace |
| `max_output_chars` | number | | Max output returned to the model (max 100000) |
| `run_in_background` | boolean | | Set true for long-running tasks |

**Behavior notes:**
- Non-zero exit codes, timeouts, and user interrupts return failed tool results with exit metadata.
- Output includes stdout and labeled stderr, with middle truncation for oversized output.
- `run_in_background` starts a supervised task; without an explicit `timeout`, the background watchdog TTL applies.

---

### ReadTool — `Read`

Reads files from the local filesystem or lists directories. Supports text, streamed line ranges for large files, image/binary summaries, and PDF text extraction with page ranges.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Output limit | 80000 chars |
| Full text read limit | 256 KB (larger files require `offset`/`limit`) |
| Directory list limit | 500 entries |
| PDF default | First 10 pages unless `pages` is provided |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | ✓ | Absolute path to the file |
| `offset` | number | | Starting line number |
| `limit` | number | | Max lines to read |
| `pages` | string | | PDF page range (e.g., "1-5") |

---

### WriteTool — `Write`

Writes UTF-8 text content to a file. Creates parent directories when needed. Requires reading the file first if it already exists, and supports overwrite guards, SHA-256 stale-write checks, dry-run validation, and no-op detection.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Is read-only | No |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | ✓ | Absolute path to the file |
| `content` | string | ✓ | Content to write |
| `create_only` | boolean | No | Fail if the target file already exists |
| `expected_sha256` | string | No | Fail unless the current file has this SHA-256 hash |
| `dry_run` | boolean | No | Validate the write without changing the filesystem |

**Behavior notes:**
- Refuses to write to directory paths, content containing NUL bytes, or existing binary files.
- Returns structured metadata including created/overwritten/noOp/dryRun, byte counts, and SHA-256 hashes.
- Skips the filesystem write when the existing file already matches the requested content.

---

### EditTool — `Edit`

Performs exact string replacements in files. Requires reading the file first. Provides replacement-count checks, dry-run validation, line-ending normalization, and diagnostics for ambiguous matches.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Is read-only | No |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | ✓ | Absolute path to the file to modify |
| `old_string` | string | ✓ | The text to find and replace |
| `new_string` | string | ✓ | Replacement text |
| `replace_all` | boolean | | Replace all occurrences (default false) |
| `expected_replacements` | number | | Fail unless exactly this many replacements would be made |
| `dry_run` | boolean | | Validate and report replacement metadata without writing |

---

### GlobTool — `Glob`

Fast file pattern matching using glob patterns.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | ✓ | Glob pattern (e.g., `**/*.ts`) |
| `path` | string | | Search directory (default: workspace) |
| `max_results` | number | | Max matching files to return (default 200, max 1000) |

---

### GrepTool — `Grep`

Powerful regex search built on ripgrep. Supports full regex, file type filtering, multiline mode, and context lines.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |
| Output limit | 250 lines default (`head_limit`) |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | ✓ | Regex pattern to search for |
| `path` | string | | File or directory to search |
| `glob` | string | | Glob filter (e.g., `*.ts`) |
| `type` | string | | File type filter (e.g., `js`, `py`) |
| `literal` | boolean | | Treat pattern as exact text instead of regex |
| `include_hidden` | boolean | | Include hidden files/directories except `.git` and `node_modules` |
| `output_mode` | string | | `content`, `files_with_matches`, or `count` |
| `-i` | boolean | | Case insensitive |
| `-n` | boolean | | Show line numbers |
| `-A` / `-B` / `-C` | number | | Context lines after/before/both |
| `head_limit` | number | | Max output entries (default 250) |
| `multiline` | boolean | | Enable multiline matching |
| `timeout_ms` | number | | Ripgrep timeout (default 15000, max 60000) |

---

### NotebookEditTool — `NotebookEdit`

Edits Jupyter notebook cells (`.ipynb` files). Supports replace, insert, and delete modes.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Is read-only | No |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `notebook_path` | string | ✓ | Absolute path to the notebook |
| `new_source` | string | ✓ | New cell content |
| `cell_id` | string | | Cell ID (required for replace/delete) |
| `edit_mode` | string | | `replace` (default), `insert`, or `delete` |
| `cell_type` | string | | `code` or `markdown` |

---

## 2. Search & Web (2 tools)

### WebFetchTool — `WebFetch`

Fetches content from a URL, converts HTML to markdown, and processes it with an AI model. Has a 15-minute self-cleaning cache.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✓ | URL to fetch (HTTP upgraded to HTTPS) |
| `prompt` | string | ✓ | What information to extract from the page |

---

### WebSearchTool — `WebSearch`

Searches the web and returns results formatted as search blocks. Supports domain filtering.

| Property | Value |
|---|---|
| Risk | `Low` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query (≥2 chars) |
| `allowed_domains` | string[] | | Only include these domains |
| `blocked_domains` | string[] | | Exclude these domains |

---

## 3. Planning & Communication (5 tools)

### SleepTool — `Sleep`

Pauses execution for a specified duration, or waits for a background task to finish without polling.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |
| Max wait | 300 seconds |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `delaySeconds` | number | No | Sleep duration in seconds, or max wait when `wait_for_task_id` is provided |
| `reason` | string | No | Why the agent is sleeping |
| `wait_for_task_id` | string | No | Background task ID to wait for |

**Behavior notes:**
- Requires either `delaySeconds` or `wait_for_task_id`.
- Waiting for a background task wakes on completion/failure and also recognizes recently completed tasks.
- Unknown, failed, killed, timed-out, or interrupted waits return failed tool results with structured task status.

---

### EnterPlanModeTool — `EnterPlanMode`

Enters plan mode where the agent acts as a software architect. In plan mode, the agent can only read and plan — no writes allowed.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |

**Parameters:** None (empty object).

---

### ExitPlanModeTool — `ExitPlanMode`

Exits plan mode and returns to normal execution. The agent resumes full tool access.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |

**Parameters:** None (empty object).

---

### AskUserQuestionTool — `AskUserQuestion`

Asks the user a question and waits for a response. Pauses the agent loop until the user answers.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |
| requiresUserInteraction | `true` |
| Min role | `MainAgent` (only the main agent can ask questions) |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `question` | string | ✓ | The question to ask the user |
| `options` | string[] | | Multiple-choice options |

---

### TodoWriteTool — `TodoWrite`

Creates and manages a structured task list for the current session. Tracks progress with `pending`, `in_progress`, and `completed` states.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `todos` | array | ✓ | Array of `{ content, status, activeForm }` items |

---

## 4. Task Delegation (7 tools)

### TaskAssignTool — `TaskAssign`

Assigns a task to a subordinate agent in the org hierarchy.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `to` | string | ✓ | Target agent name or ID |
| `message` | string | ✓ | Task description or instruction |
| `summary` | string | | Short summary for UI display |

---

### TaskListTool — `TaskList`

Lists all tasks assigned to or by the current agent.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:** None (empty object).

---

### TaskOutputTool — `TaskOutput`

Retrieves output from a running or completed background task. Supports blocking and non-blocking modes.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | ✓ | ID of the task to retrieve |
| `block` | boolean | ✓ | Whether to wait for completion |
| `timeout` | number | ✓ | Max wait time in ms |

---

### TaskStopTool — `TaskStop`

Stops a running background task.

| Property | Value |
|---|---|
| Risk | `Medium` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | | Task ID to stop |
| `shell_id` | string | | (Deprecated) Shell ID |

---

### AgentMessageTool — `AgentMessage`

Sends a message to another agent in the org tree.

| Property | Value |
|---|---|
| Risk | `Medium` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `to` | string | ✓ | Recipient agent name or `main` |
| `message` | string | ✓ | Plain text message content |
| `summary` | string | | Short summary for UI |

---

### SubAgentSpawnTool — `SubAgentSpawn`

Spawns a new sub-agent to handle a delegated task. The sub-agent inherits context from the parent.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Min role | `Member` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✓ | Short description for logging and UI |
| `prompt` | string | ✓ | Full task instructions for the sub-agent |
| `subagent_type` | string | | Specialized agent type |

---

### SubAgentDeleteTool — `SubAgentDelete`

Removes a sub-agent from the org tree. Stops the agent if running.

| Property | Value |
|---|---|
| Risk | `Medium` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | ✓ | ID of the sub-agent to delete |

---

## 5. Organization Management (3 tools)

### HireEmployeeTool — `HireEmployee`

Creates a new employee agent with a specific role and adds it to the org hierarchy.

| Property | Value |
|---|---|
| Risk | `High` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Display name for the new agent |
| `role` | string | ✓ | Agent role (`Manager`, `Member`, `SubAgent`) |
| `description` | string | | Job description / responsibilities |

---

### ListEmployeesTool — `ListEmployees`

Lists all employees in the organization hierarchy.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:** None (empty object).

---

### UpdateOrgTool — `UpdateOrg`

Updates the organization structure — move agents, change roles, reassign relationships.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✓ | Update action type |
| `agent_id` | string | ✓ | Target agent |
| `changes` | object | ✓ | Fields to update |

---

## 6. Memory & Skills (7 tools)

### MemorySaveTool — `memory_save`

Saves a new memory entry.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | `personal`, `team`, `project`, `session_personal`, `session_team` |
| `type` | string | ✓ | `user`, `feedback`, `project`, `reference` |
| `name` | string | ✓ | Short descriptive name |
| `content` | string | ✓ | Full memory content |

---

### MemorySearchTool — `memory_search`

Searches saved memories using fuzzy/semantic scoring (fuse.js).

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query |
| `scope` | string | | Filter by scope |
| `type` | string | | Filter by memory type |
| `limit` | number | | Max results (default 10) |

---

### MemoryDeleteTool — `memory_delete`

Deletes a memory entry by name or ID.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Memory entry name or ID |
| `scope` | string | | Memory scope |

---

### MemoryRecallTool — `memory_recall`

Recalls specific memory entries. Returns full content for use in context.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Memory entry name or ID |
| `scope` | string | | Memory scope |

---

### SkillTool — `Skill`

Invokes a skill by name. Skills provide specialized capabilities and domain knowledge.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | true |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `skill` | string | ✓ | Skill name (no leading slash) |
| `args` | string | | Optional arguments for the skill |

---

### SkillListTool — `SkillList`

Lists all available skills for the current agent.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:** None (empty object).

---

### SkillInspectTool — `SkillInspect`

Shows detailed information about a specific skill including its description, triggers, and instructions.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `skill` | string | ✓ | Skill name to inspect |

---

## 7. Browser (1 tool)

### BrowserAgentTool — `Browser`

Launches a browser automation agent for web interaction tasks. Supports navigation, element interaction, form filling, JS debugging, and screenshot capture.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Async | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `url` | string | | Starting URL |
| `task` | string | ✓ | Task description for the browser agent |

---

## 8. System (2 tools)

### ApiCallTool — `ApiCall`

Makes internal API calls to AnoClaw endpoints. Used for programmatic system operations.

| Property | Value |
|---|---|
| Risk | `High` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `method` | string | ✓ | HTTP method (`GET`, `POST`, `PUT`, `DELETE`) |
| `path` | string | ✓ | API path (e.g., `/api/v1/sessions`) |
| `body` | object | | Request body for POST/PUT |

---

### RestartServerTool — `RestartServer`

Restarts the AnoClaw server process. Requires user confirmation due to destructive nature.

| Property | Value |
|---|---|
| Risk | `High` |
| InterruptBehavior | `Block` |

**Parameters:** None (empty object).

---

## Auto-Registration

Tools are discovered at startup by `ToolRegistrar.registerAllTools()`:

```
bootstrap/ToolRegistrar.ts
  ↓
scans dist/server/core/tools/builtin/*.js
  ↓
for each file: import → extractTool()
  ↓
finds first Tool subclass (default export or named)
  ↓
ToolRegistry.registerTool(instance, instance.constructor.category)
```

**To add a new tool:**
1. Create `src/server/core/tools/builtin/YourTool.ts` extending `Tool`
2. Set `static category` to one of the 8 categories
3. Implement `name()`, `description()`, `parametersSchema()`, `execute()`
4. Run `npm run build`
5. Tool is available immediately — no import or registration code needed

## Call Chain

```
ToolRegistrar.registerAllTools()     ← startup only
  │
  └─► ToolRegistry.registerTool()    ← one per tool file
        │
        ▼
AgentLoop                             ← runtime
  │
  └─► ToolRegistry.execute(toolName, params, ctx)
        │
        ├─► Plugin override? (extensionPoints.get('toolExecutor'))
        ├─► Tool lookup
        ├─► Role permission check (canUseTool)
        │
        └─► ToolPipeline.run(tool, params, ctx, toolCallId)
              │
              ├─ validateParams()      ← JSON Schema check
              ├─ securityCheck()       ← risk + read-only mode
              ├─ execute()             ← tool._executeWithEvents() → tool.execute()
              ├─ retry()               ← transient errors only
              └─ normalizeOutput()     ← truncation
```
