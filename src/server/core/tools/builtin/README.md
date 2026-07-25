# Built-in Tools

`ToolRegistrar` scans this directory at startup. Each built-in tool extends
`Tool`; creating a new file and rebuilding is enough to register it.

## Coordination tools

| Group | Tools |
|---|---|
| Team | `TeamCreate`, `TeamUpdate`, `TeamStatus`, `TeamDelete`, `TeamMemberAdd`, `TeamMemberUpdate`, `TeamMemberRemove`, `AgentList` |
| Durable work | `MissionCreate`, `TaskCreate`, `TaskAssign`, `TaskClaim`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskVerify` |
| Messaging | `AgentMessage` |
| Process job | `JobList`, `JobOutput`, `JobStop` |

Tasks and process Jobs are intentionally separate. Agent work is always stored
in the v3 Work JSONL event stream; `BackgroundTaskManager` is only for Bash and
native program processes.

`TaskCreate` declares acceptance criteria, dependencies, read-only mode, and
write scope. `TaskAssign` chooses an eligible worker but does not mark work
complete. The scheduler claims and runs ready tasks, and the runtime commits a
terminal state only after actual execution.

`AgentMessage` writes to a durable FIFO mailbox. Team members can address peers
or broadcast. `steer` requires a running recipient, while `note` waits for the
recipient's next Team Run.

AnoClaw 3.0 has no temporary worker or hierarchy-management tools.
`HireEmployee`, `ListEmployees`, `UpdateOrg`, and `SubAgentSpawn` are retired:
persistent Team membership is the only multi-Agent organization model.

## Tool execution safety

The effective tool set is the intersection of the agent allowlist, Team policy,
and task mode. `ToolPipeline` enforces the coordination execution context:

- read-only tasks cannot use write tools;
- `Write`, `Edit`, and `NotebookEdit` targets must be inside declared scopes;
- `Bash` and `RunProgram` require the full-workspace `"."` lease;
- every modifying call must be covered by the running task lease.

See [anoclaw-3-architecture.md](../../../../../docs/anoclaw-3-architecture.md)
for the full contract.
