# Built-in Tools

`ToolRegistrar` scans this directory at startup. Each built-in tool extends
`Tool`; creating a new file and rebuilding is enough to register it.

## Coordination tools

| Group | Tools |
|---|---|
| Team roster | `ListEmployees`, `HireEmployee`, `UpdateOrg` |
| Session Team | `TeamCreate`, `TeamUpdate`, `TeamStatus`, `TeamDelete` |
| Durable task | `TaskCreate`, `TaskAssign`, `TaskClaim`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop` |
| Messaging | `AgentMessage` |
| Temporary worker | `SubAgentSpawn` |
| Process job | `JobList`, `JobOutput`, `JobStop` |

Tasks and process Jobs are intentionally separate. Agent work is always stored
by `CoordinationService`; `BackgroundTaskManager` is only for Bash and native
program processes.

All roster, session-Team, and messaging tools appear under the `Agent Teams`
tool group. The roster is durable across sessions: `HireEmployee` creates an
agent and `UpdateOrg` changes reporting lines. A session Team is temporary and
only references existing active employees for the current root session.

`TaskCreate` declares acceptance criteria, dependencies, read-only mode, and
write scope. `TaskAssign` chooses an eligible worker but does not mark work
complete. The scheduler claims and runs ready tasks, and the runtime commits a
terminal state only after actual execution.

`AgentMessage` writes to a durable FIFO mailbox. Team members can address peers
or broadcast; outside a Team the organization parent/child restriction applies.
`steer` requires a running recipient, while `note` may wait for the next task.

`SubAgentSpawn` accepts `contextMode: isolated | summary | fork` and optional
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
