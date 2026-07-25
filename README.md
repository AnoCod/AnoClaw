# AnoClaw 3.0

AnoClaw is a local-first autonomous AI company for Windows. Most users talk
only to MainAgent; persistent Teams and independent Agents organize work,
delegate, execute, verify, remember, and communicate behind that simple
conversation.

The Work screen keeps the company transparent. Users can inspect Agent
conversations, execution stages, deliverables, current activity, and the live
company floor without manually operating the scheduler.

## Download

Open [Releases](https://github.com/AnoCod/AnoClaw/releases) and download:

- `AnoClaw.Setup.3.0.0.exe` — normal Windows installer.
- `AnoClaw-3.0.0-win-unpacked.zip` — portable build.

AnoClaw does not require an account or cloud server. LLM provider credentials,
Company data, memories, Work records, and transcripts stay on the local
computer.

## Build from source

```bash
npm install
npm run build:all
npm test
npx electron-builder --win
```

Output:

- Installer: `release9/AnoClaw Setup 3.0.0.exe`
- Unpacked app: `release9/win-unpacked/AnoClaw.exe`

Do not use `npm run dev` outside Windows `cmd.exe`. The supported verification
path is `npm run build:all`, packaging, and launching the unpacked application.

## Product model

- **Company** — one local autonomous organization per installation.
- **Team** — persistent, nested, and able to grow over time.
- **Agent** — an independent persistent runtime with its own responsibilities,
  model, tools, skills, memories, sessions, and status.
- **MainAgent** — the normal user-facing Agent and company-level coordinator.
- **Work** — either a one-off request or a long-running project.
- **Workspace** — an optional filesystem boundary for Work.
- **Mission → Task → Run** — server-owned planning, scheduling, execution, and
  verification.
- **Session** — transcript and execution evidence, not organization state.

All multi-Agent collaboration uses persistent Teams. Adding an employee is a
Team member operation; there is no separate public Hire Employee or temporary
SubAgent mental model in 3.0.

## Features

- Persistent Company, nested Teams, memberships, and Agents
- Event-driven capability-aware multi-Agent scheduling
- Durable FIFO Agent messaging and transparent conversation trees
- Dependency-aware Tasks, Run evidence, independent verification, and retries
- Git worktree isolation with pessimistic lease fallback for non-Git Workspaces
- Tool-call write-ahead journal and crash-safe recovery decisions
- Local JSONL event streams with rebuildable projections
- Streaming Agent runtime, tools, skills, MCP, memory, and plugins
- Apple-minimal dark UI with low-poly robot employees
- Instant persisted Simplified Chinese and English interface switching
- Simple MainAgent-focused view and professional transparent company view

## Storage

Version 3 starts clean and does not import or dual-write v2 state.

| Path | Purpose |
|---|---|
| `data/v3/company/` | Company, Workspace, Team, membership, and Agent events |
| `data/v3/work/` | Work, Mission, Task, Run, messages, leases, and verification |
| `data/v3/transcript/` | Session transcript evidence |
| `memory/` | Company, Team, Agent, Workspace, Work, and Mission knowledge |
| `config/settings.yaml` | Local runtime and LLM provider settings |

JSONL is the source of truth. Projection files are disposable startup
checkpoints.

See [AnoClaw 3.0 Architecture](docs/anoclaw-3-architecture.md) for the durable
model and execution invariants.

## Tech stack

TypeScript, Node.js `http`, `ws`, Preact, esbuild, and Electron 42. No Express
and no database.

## License

MIT
