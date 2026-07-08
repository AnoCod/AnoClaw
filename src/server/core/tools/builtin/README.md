# Built-in Tools — `src/server/core/tools/builtin/`

36 built-in tools organized into 8 categories. Tools are auto-registered by `ToolRegistrar` scanning this directory at startup — simply place a new `.ts` file here and rebuild.

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
| `WebFetchTool.ts` | `WebFetch` | Search & Web | Low | SubAgent |
| `WebSearchTool.ts` | `WebSearch` | Search & Web | Low | SubAgent |
| `SleepTool.ts` | `Sleep` | Planning & Communication | Safe | SubAgent |
| `PlanTool.ts` | `Plan` | Planning & Communication | Low | SubAgent |
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
| `SubAgentDeleteTool.ts` | `SubAgentDelete` | Task Delegation | Low | SubAgent |
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
- `description`, `timeout`, `max_output_chars`, and `run_in_background` are strictly validated before any process is spawned.
- `run_in_background` starts a supervised task; without an explicit `timeout`, the background watchdog TTL applies.

---

### ReadTool — `Read`

Reads files from the local filesystem or lists directories. Supports text, streamed line ranges, tail reads for large logs, optional line numbers, image/binary summaries, and PDF text extraction with page ranges.

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
| `tail` | number | | Read the last N lines of a text file; max 5000; cannot be combined with `offset`/`limit` |
| `line_numbers` | boolean | | Prefix returned text lines with 1-based line numbers |
| `max_chars` | number | | Max characters returned by the tool, default/max 80000 |

**Behavior notes:**
- Invalid range values are rejected instead of silently clamped.
- Text output is truncated inside the tool with metadata before pipeline truncation.
- `tail` streams the file and keeps only the requested trailing lines in memory.
- Results include structured metadata for file kind, size, line ranges, truncation, and directory counts.

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

Performs exact string replacements in files. Requires reading the file first. Provides replacement-count checks, stale-file hash checks, dry-run validation, line-ending normalization, and diagnostics for ambiguous matches.

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
| `expected_sha256` | string | | Fail if the current file hash differs from the hash read earlier |
| `dry_run` | boolean | | Validate and report replacement metadata without writing |

**Behavior notes:**
- Invalid string/boolean/number/hash parameters fail fast instead of being coerced.
- `new_string` may be empty for deletion edits; `old_string` must be non-empty.
- Successful and failed validations include structured metadata such as hashes, byte counts, sampled line numbers, and replacement counts.

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
| `include_hidden` | boolean | | Include hidden files/directories (default false) |
| `include_node_modules` | boolean | | Include `node_modules` directories (default false) |
| `exclude` | string[] | | Glob patterns to exclude relative to the search path |
| `timeout_ms` | number | | Max scan time (default 15000ms, max 60000ms) |
| `max_output_chars` | number | | Max output characters (default/max 25000) |

**Behavior notes:**
- Invalid numeric/boolean/list parameters fail fast instead of being silently clamped.
- Results include structured metadata for match counts, scanned entries, skipped paths, truncation, timeout, and output limits.
- Hidden paths and `node_modules` are skipped by default to keep broad searches fast and relevant.

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
| `max_output_chars` | number | | Max characters returned by the tool, default/max 25000 |

**Behavior notes:**
- Numeric and boolean parameters are validated strictly; invalid values fail fast.
- Results include structured metadata for backend, output mode, filters, truncation, timeout, and line count.
- `max_output_chars` truncates inside the tool before pipeline normalization.

---

### NotebookEditTool — `NotebookEdit`

Edits Jupyter notebook cells (`.ipynb` files). Supports replace, insert, delete, dry-run validation, stale-file hash checks, and stale code-output cleanup.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Is read-only | No |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `notebook_path` | string | ✓ | Absolute path to the notebook |
| `new_source` | string | | New cell content (required for replace/insert) |
| `cell_id` | string | | Target cell ID |
| `cell_number` | number | | 0-indexed target cell number |
| `edit_mode` | string | | `replace` (default), `insert`, or `delete` |
| `cell_type` | string | | `code` or `markdown` |
| `expected_sha256` | string | | Fail if the current notebook hash differs from the hash read earlier |
| `dry_run` | boolean | | Validate and report notebook edit metadata without writing |
| `clear_outputs` | boolean | | Clear stale outputs and `execution_count` when replacing a code cell; defaults to `true` |

**Behavior notes:**
- Invalid string/boolean/number/enum/hash parameters fail fast instead of being coerced.
- `cell_id` and `cell_number` are mutually exclusive; missing explicit targets fail instead of falling back to a different cell.
- Existing string-array `source` cells keep their array representation after replacement.
- Replacing a code cell clears stale outputs by default so notebook results do not imply that changed code has already run.
- Results include structured metadata for operation, cell index/ID/type, cell counts, byte counts, and hashes.

---

## 2. Search & Web (2 tools)

### WebFetchTool — `WebFetch`

Fetches content from a URL, converts HTML/JSON/text to readable text, and returns bounded output with cache, timeout, focused-excerpt, and structured failure metadata.

| Property | Value |
|---|---|
| Risk | `Low` |
| Is read-only | Yes |
| Timeout | 60s internal default, configurable via `timeout_ms` up to 90s |
| Cache | 15-minute URL cache, bypassable with `use_cache: false` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✓ | URL to fetch (HTTP upgraded to HTTPS) |
| `prompt` | string | | Optional focus prompt; returned excerpts prioritize matching terms |
| `max_content_chars` | number | | Max content chars returned, default 15000, max 80000 |
| `timeout_ms` | number | | Total fetch timeout, default 60000, max 90000 |
| `retry_attempts` | number | | Network attempts, default 2, max 3 |
| `use_cache` | boolean | | Use cached fetched text when available, default true |

**Behavior notes:**
- Applies the output character cap before returning content, rather than relying only on pipeline truncation.
- Returns structured status for `ok`, `cached`, `http_error`, `timeout`, `aborted`, and `failed`.
- User interrupts cancel active fetches and retry backoff.
- SSRF protection checks literal IPs and DNS lookup results for IPv4 and IPv6 private/internal ranges.

---

### WebSearchTool — `WebSearch`

Searches the web and returns results formatted as search blocks. Supports bounded total timeouts, backend-level diagnostics, max-result control, and exact/subdomain domain filtering.

| Property | Value |
|---|---|
| Risk | `Low` |
| Is read-only | Yes |
| Timeout | 15s internal default, configurable via `timeout_ms` up to 60s |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query (2-500 chars after trimming) |
| `allowed_domains` | string[] | | Only include these domains or their subdomains |
| `blocked_domains` | string[] | | Exclude these domains or their subdomains |
| `max_results` | number | | Max results returned, default 10, max 10 |
| `timeout_ms` | number | | Total search timeout, default 15000, max 60000 |

**Behavior notes:**
- Tries DuckDuckGo Lite, DuckDuckGo HTML, then Bing within one total timeout budget.
- Failed searches return structured backend attempts instead of hanging or hiding the failure reason.
- User interrupts cancel in-flight network work and return a clear cancelled result.
- DuckDuckGo redirect URLs are decoded before filtering and returning results.

---

## 3. Planning & Communication (6 tools)

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

### PlanTool — `Plan`

Writes a concrete markdown plan file in the workspace, with dry-run validation and explicit overwrite protection.

| Property | Value |
|---|---|
| Risk | `Low` |
| Is read-only | No |
| shouldDefer | `true` |
| InterruptBehavior | `Block` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Short plan name used for `plan-{name}.md` |
| `content` | string | ✓ | Full markdown plan content |
| `overwrite` | boolean | | Replace an existing plan with the same sanitized name (default false) |
| `dry_run` | boolean | | Validate and preview metadata without writing |

**Behavior notes:**
- Invalid string/boolean parameters fail fast instead of being coerced.
- Existing plan files are not overwritten unless `overwrite=true`.
- Results include structured metadata for sanitized name, path, byte count, line count, checkbox count, and step heading count.

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

Exits plan mode and returns to normal execution. The agent resumes full tool access and may include exact Bash commands the user already approved during plan review.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `allowedPrompts` | array | No | Optional exact Bash commands to auto-approve after plan mode, as `{ tool: "Bash", prompt: "command" }` entries |

**Behavior notes:**
- Approved prompts are matched against the concrete Bash `command` after trimming whitespace; approving one Bash command only skips confirmation for that command and does not bypass read-only or plan-mode restrictions.
- Invalid nested prompt entries fail fast before leaving plan mode.
- Calling without `allowedPrompts` clears any stale approved prompts for the session.

---

### AskUserQuestionTool — `AskUserQuestion`

Asks the user one or more clarifying questions and waits for a response. Pauses the agent loop until the user answers or interrupts.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |
| requiresUserInteraction | `true` |
| Min role | `MainAgent` (only the main agent can ask questions) |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `questions` | array | ✓ | 1-4 question objects: `{ question, header, options?, multiSelect? }` |

**Question object:**
| Name | Type | Required | Description |
|---|---|---|---|
| `question` | string | ✓ | The actual question; max 1000 chars |
| `header` | string | ✓ | Short label; max 12 chars |
| `options` | string[] | | Up to 4 short option labels; omitted or empty means free-text input |
| `multiSelect` | boolean | | Only valid when options are present |

**Reliability notes:**
- Questions and options are trimmed before display; duplicate options are removed.
- Malformed entries fail before the conversation enters the user-wait state.
- The result includes structured `askUserStatus`, normalized questions, session ID, agent ID, and question count.

---

### TodoWriteTool — `TodoWrite`

Creates and manages a normalized structured task list for the current session. Tracks progress with `pending`, `in_progress`, and `completed` states, emits todo update events for the UI, and rejects ambiguous list state.

| Property | Value |
|---|---|
| Risk | `Safe` |
| shouldDefer | `true` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `todos` | array | ✓ | Complete replacement list of `{ content, status, activeForm }` items; max 50. Empty array clears the visible list |

**Behavior notes:**
- Whitespace is normalized before emitting/persisting todos.
- At most one todo may be `in_progress`; duplicate task content is rejected.
- `content` is capped at 300 chars and `activeForm` at 160 chars.

---

## 4. Task Delegation (7 tools)

### TaskAssignTool — `TaskAssign`

Assigns a tracked task to a direct subordinate agent in the org hierarchy.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetAgentId` | string | ✓ | Direct subordinate agent ID |
| `task` | string | ✓ | Task description, scope, acceptance criteria, and verification requirements |
| `priority` | string | | `low`, `normal`, `high`, or `urgent`; defaults to `normal` |

**Reliability notes:**
- Inputs are trimmed, bounded, and validated before registry/runtime dispatch.
- Tasks can only be assigned to immediate child agents; cross-tree or grandchild delegation is rejected before runtime dispatch.
- Successful background delegation returns structured metadata including `taskId` (`bt-*`), `subSessionId`, priority, and target agent. Use that `taskId` with `TaskOutput` or `TaskStop`.

---

### TaskListTool — `TaskList`

Lists delegated sub-sessions, active background tasks, and recent background task results for the current session.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |

**Parameters:** None (empty object).

---

### TaskOutputTool — `TaskOutput`

Retrieves output or status from a delegated sub-session or `bt-*` background task.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | No | Task ID or sub-session ID to retrieve |
| `task_id` | string | No | Alias for `taskId` |
| `max_chars` | integer | No | Maximum output characters to return; default `4000`, max `50000` |
| `include_history` | boolean | No | Include delegated session transcript/output excerpts; default `true` |
| `include_tool_messages` | boolean | No | Include tool messages in delegated session output; default `true` |
| `tail_messages` | integer | No | Maximum assistant/tool messages to include from the end of a delegated session; default `50`, max `100` |

**Behavior notes:**
- For `bt-*` IDs, returns active status or a recent completed/failed/killed result.
- Failed, killed, unknown, or expired `bt-*` task lookups return failed tool results with structured status.
- Long background or delegated-session outputs are bounded by `max_chars` and report `wasTruncated`, original size, returned size, and omitted message counts in structured metadata.
- When both `taskId` and `task_id` are provided, they must resolve to the same trimmed ID.

---

### TaskStopTool — `TaskStop`

Stops a running delegated sub-session or `bt-*` background task.

| Property | Value |
|---|---|
| Risk | `Medium` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | No | Task ID or sub-session ID to stop |
| `task_id` | string | No | Alias for `taskId` |

**Behavior notes:**
- For `bt-*` Bash tasks, attempts to terminate the local process tree before marking the task killed.
- Already completed/failed/killed tasks return a clear failure result instead of pretending a stop happened.
- Delegated session stops return structured status for both interrupted and already-not-running sessions.

---

### AgentMessageTool — `AgentMessage`

Sends a message to another agent in the org tree.

| Property | Value |
|---|---|
| Risk | `Low` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetAgentId` | string | ✓ | Direct parent or child agent ID |
| `content` | string | ✓ | Plain text coordination message; max 20,000 chars |
| `summary` | string | | Short label for UI/background task list; max 120 chars |

**Reliability notes:**
- `targetAgentId`, `content`, and `summary` are strictly validated before registry/session work starts.
- If the recipient is idle, the tool starts tracked background processing and returns a `Task ID`.
- Background delivery failures are recorded as failed tasks, so callers can inspect them with `TaskOutput` instead of waiting indefinitely.

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
| `subagent_type` | string | ✓ | Specialized agent type: `Explore`, `Plan`, or `general-purpose` |
| `model` | string | | `haiku` or `sonnet`; defaults to `sonnet` |
| `persist` | boolean | | Keep the transcript/session for later inspection; defaults to `false` |
| `run_in_background` | boolean | | Register a tracked background sub-agent task and return immediately |

**Reliability notes:**
- `description`, `prompt`, `subagent_type`, `model`, `persist`, and `run_in_background` are validated before any SubAgent runtime is touched.
- Background runs are registered in `BackgroundTaskManager`, return a `Task ID`, and complete or fail through the unified `<task-notification>` path.
- Failed background SubAgents are recorded as failed tasks instead of being reported as completed delegations.

---

### SubAgentDeleteTool — `SubAgentDelete`

Destroys and unregisters a live temporary SubAgent. Durable Managers/Members cannot be deleted with this tool, and persisted transcripts are preserved for audit.

| Property | Value |
|---|---|
| Risk | `Medium` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | ✓ | ID of the SubAgent to delete |
| `dry_run` | boolean | | Preview the delete without mutating the registry; defaults to `false` |
| `reason` | string | | Optional short audit/debug reason; max 500 chars |

**Reliability notes:**
- Inputs are trimmed and bounded; unexpected parameters are rejected.
- Non-SubAgent roles are refused with structured `wrong_role` feedback and are not unregistered.
- Destroyed stale SubAgent entries are cleaned idempotently from the registry.
- Results include structured `status`, `deleted`, `unregistered`, and `sessionAction`; transcripts are preserved rather than hard-deleted.

---

## 5. Organization Management (3 tools)

### HireEmployeeTool — `HireEmployee`

Creates a durable employee agent with a specific role and adds it to the organization hierarchy.
Use `SubAgentSpawn` for one-off temporary helpers.

| Property | Value |
|---|---|
| Risk | `High` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Professional display name for the new agent |
| `role` | string | ✓ | Durable org role (`Manager` or `Member`) |
| `parentAgentId` | string | ✓ | Existing manager/MainAgent ID that the new agent reports to |
| `agentPrompt` | string | ✓ | Concise system prompt defining identity, scope, quality bar, and escalation rules |
| `reason` | string | ✓ | Business justification for creating a persistent employee |
| `model` | string | | Optional model override; omitted values inherit the parent agent model |
| `teamName` | string | | Optional team grouping; blank values inherit the parent team |
| `allowedTools` | string[] | | Optional tool whitelist; omitted values inherit parent tools |
| `enabledSkills` | string[] | | Optional skill whitelist |
| `mcpServers` | string[] | | Optional MCP server names |

**Reliability notes:**
- `role` is limited to `Manager` and `Member`; Managers cannot create other Managers.
- Strings are trimmed, bounded, and rejected if empty where required.
- Tool, skill, and MCP server lists are bounded, trimmed, and deduplicated.
- Invalid input fails before touching `AgentRegistry`, so malformed requests cannot create partial agents.
- The result includes structured metadata: new `agentId`, role, parent, team, tool/skill/MCP lists, and whether the model was inherited.

---

### ListEmployeesTool — `ListEmployees`

Lists all employees in the organization hierarchy with structured health metadata.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:** None (empty object).

**Reliability notes:**
- Rejects unexpected parameters through the shared schema pipeline and at execution time.
- Traverses from the MainAgent with cycle protection, so corrupted reporting chains are reported instead of recursing forever.
- Reports orphaned or unreachable agents separately when their parent chain does not connect to the MainAgent.
- Includes structured metadata for totals, active/destroyed counts, root agent, all agents, orphaned agents, cycle IDs, and org health status.

---

### UpdateOrgTool — `UpdateOrg`

Reassigns an agent to a different active manager in the organization tree.

| Property | Value |
|---|---|
| Risk | `Medium` |
| Min role | `Manager` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | ✓ | Agent ID or exact agent name to move |
| `newParentId` | string | ✓ | New parent agent ID or exact name; must be an active MainAgent or Manager |

**Reliability notes:**
- Inputs are trimmed, bounded, and rejected before registry access if malformed.
- The MainAgent cannot be moved.
- The new parent must exist, be active, and be able to manage subordinates.
- Self-parenting, no-op moves, and circular reporting chains are detected explicitly.
- Persistence failures roll back the in-memory parent/level change and return structured failure metadata.
- Successful results include structured old/new parent IDs, names, levels, and status.

---

## 6. Memory & Skills (7 tools)

### MemorySaveTool — `memory_save`

Saves a durable memory entry with validation and structured feedback.

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
| `description` | string | | Optional one-line summary |

---

### MemorySearchTool — `memory_search`

Searches saved memories with bounded snippets and structured results.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search query |
| `scope` | string | | `team`, `personal`, `session_personal`, `session_team`, `all` (default) |
| `fuzzy` | boolean | | Enable fuzzy matching; default true |
| `limit` | number | | Max results returned, default 10, max 50 |
| `max_snippet_chars` | number | | Max preview chars per memory, default 200, max 1000 |

**Behavior notes:**
- `scope`, `fuzzy`, `limit`, and `max_snippet_chars` are strictly typed; ambiguous strings or non-integer limits fail fast instead of being coerced.
- Structured results include the effective `fuzzy` setting, total matches, returned count, and truncated snippets.

---

### MemoryDeleteTool — `memory_delete`

Deletes a memory entry by exact name, or checks existence with `dry_run`.

| Property | Value |
|---|---|
| Risk | `Safe` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | `personal`, `team`, `project`, `session_personal`, `session_team` |
| `name` | string | ✓ | Exact memory entry name |
| `dry_run` | boolean | | Check existence without deleting |

**Behavior notes:**
- `dry_run` must be a boolean; string values are rejected before any delete lookup or removal.

---

### MemoryRecallTool — `memory_recall`

Recalls full memory content by index or name with bounded output.

| Property | Value |
|---|---|
| Risk | `Safe` |
| Is read-only | Yes |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Index number from the Memory section, or memory name/query |
| `scope` | string | | `agent`, `personal`, `team`, `session`, `all` (default) |
| `max_content_chars` | number | | Max content returned per memory, default 12000, max 50000 |
| `limit` | number | | Max named matches returned, default 5, max 20 |

**Behavior notes:**
- `scope`, `max_content_chars`, and `limit` are strictly typed; ambiguous values fail before memory search starts.
- Structured results include the requested scope plus effective output limits so callers can tell whether content was truncated.

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

Makes bounded internal API calls to AnoClaw endpoints, with endpoint/tool discovery, structured status metadata, timeout feedback, and large-response preview envelopes.

| Property | Value |
|---|---|
| Risk | `High` |
| InterruptBehavior | `Cancel` |
| Timeout | 15s default, configurable via `timeout_ms` |

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `action` | string | | `call`, `discover`, or `tools`; defaults to `call`, or `discover` when only `search` is provided |
| `method` | string | | HTTP method (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`); default `GET` |
| `path` | string | | API path or template, e.g. `/api/v1/agents/:id` |
| `params` | object | | Path params for `:placeholders` |
| `query` | object | | Query string values; strings, numbers, booleans, arrays, null, or undefined |
| `body` | object | | JSON body for non-GET `call` requests |
| `search` | string | | Search text for endpoint/tool discovery |
| `category` | string | | Endpoint category filter for `discover` |
| `group` | string | | Tool group/category filter for `tools` |
| `source` | string | | Tool source filter: `builtin`, `plugin`, `external` |
| `risk` | string | | Tool risk filter |
| `readOnly` | boolean | | Read-only tool filter |
| `detail` | boolean | | Include tool parameter schemas |
| `limit` | number | | Discovery result limit; endpoints max 200, tools max 500 |
| `timeout_ms` | number | | Internal API timeout, default 15000, max 60000 |
| `max_response_chars` | number | | Max response chars before returning a JSON preview envelope, default 16000, max 100000 |

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
