# Built-in Tools

`ToolRegistrar` scans this directory at startup. Each built-in tool extends
`Tool`; creating a new file and rebuilding is enough to register it.

## Coordination tools

| Group | Tools |
|---|---|
| Team roster | `Organization` actions `list`, `hire`, `reassign` |
| Session Team | `Team` actions `create`, `update`, `status`, `delete` |
| Durable task | `Task` actions `create`, `assign`, `claim`, `update`, `list`, `output`, `stop` |
| Messaging | `AgentMessage` |
| Temporary worker | `Task` action `spawn` |
| Process job | `JobList`, `JobOutput`, `JobStop` |

Tasks and process Jobs are intentionally separate. Agent work is always stored
by `CoordinationService`; `BackgroundTaskManager` is only for Bash and native
program processes.

Organization, Team, and messaging appear under the `Agent Teams` tool group.
The Organization is durable across sessions. A Team is temporary and only
references existing active employees for the current root session.

`Task` action `create` declares acceptance criteria, dependencies, read-only
mode, and write scope. Supplying `targetAgentId` creates and assigns in one
call. The scheduler claims and runs ready tasks, and the runtime commits a
terminal state only after actual execution.

`AgentMessage` writes to a durable FIFO mailbox. Team members can address peers
or broadcast; outside a Team the organization parent/child restriction applies.
`steer` requires a running recipient, while `note` may wait for the next task.

`Task` action `spawn` accepts `contextMode: isolated | summary | fork` and optional
read/write scope. Temporary agent configuration is never persisted after the
run, but its task, session transcript, and output are durable.

## Tool execution safety

The effective tool set is the intersection of the agent allowlist, Team policy,
and task mode. `ToolPipeline` enforces the coordination execution context:

- read-only tasks cannot use write tools;
- `Write`, `Edit`, and `NotebookEdit` targets must be inside declared scopes;
- `Bash` and `RunProgram` require the full-workspace `"."` lease;
- every modifying call must be covered by the running task lease.

See [multi-agent-coordination.md](../../../../../docs/multi-agent-coordination.md)
for the full contract.
