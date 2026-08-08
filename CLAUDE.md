# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Primary Reference

**`AGENTS.md` is the canonical repository instruction file.** It contains the full architecture, commands, conventions, and workflows. Read it before making any substantial change. `docs/` holds focused design docs. This file adds the project's Karpathy-style engineering rules and points to the essentials.

## Commands

```bash
npm install            # dependencies (npm only, not pnpm)
npm run build          # TypeScript compile (server + shared → dist/)
npm run build:frontend # frontend only (Monaco + CSS + icons + plugin frontends)
npm run build:all      # full build (electron, server, frontend, CSS, icons, plugins)
npm test               # Vitest run (all tests)
npm run test:watch     # Vitest watch mode
npx electron-builder --win   # package installer (output in release9/)
```

- `npm run dev` / `npm start` require Windows `cmd.exe` — they will NOT work in Git Bash, WSL, or PowerShell. Use `npm run build:all` instead.
- Two TypeScript compilations: root `tsconfig.json` → `dist/` (server), and `src/public/tsconfig.json` → `src/public/js/` (frontend). Run `npm run build:all` if both changed.
- Path aliases `@shared/*`, `@server/*`, `@public/*` resolve at compile time only (see `vitest.config.ts` for the test-time mapping).

## Architecture (summary — full detail in AGENTS.md)

AnoClaw is an Electron desktop app with a browser SPA frontend and a single-threaded Node.js HTTP+WebSocket backend. No Express, no database — pure `http` module with JSONL append-only storage.

- **Four layers**: Presentation (`src/public/`) → ViewModel (`src/public/ts/viewmodel/`) → Service (`src/server/core/`) → Infrastructure (`src/server/infra/`).
- **Two HTTP servers, one process**: `main.ts` on :3456 (static files, WebSocket streaming, skill CRUD) and `ApiServer` on :15730 (external REST API, token-authenticated localhost).
- **Core flow**: WebSocket `send_message` → `AgentRuntime.processMessage()` → `AgentLoop` (ReAct async generator) → `PromptAssembler` → LLM → `ToolRegistry`; events stream back over WS.
- **Storage**: JSONL append-only (`data/sessions/<id>/shard_*.jsonl`), session tree (MainSession → SubSessions).
- **Plugins**: VSCode-style extensions running in Worker Threads (fault isolation, NOT a security sandbox).
- **Native MCP**: `src/server/infra/mcp/` is the kernel MCP service (stdio/SSE/HTTP, configs in `data/mcp-servers.json`, six agent tools); the `anoclaw-mcp` plugin is retired and remains only as `.disabled` for data migration.
- **Ecosystem Bridge**: `src/server/core/ecosystem/` live-mounts Codex / Claude Code / OpenClaw / OpenCode / Hermes skills, MCP, commands, agents, and plugin bridges without copying files; starts before PluginHost; state in `data/ecosystem.json`; docs in `docs/ecosystem-compatibility.md`.
- **Singletons**: most core services use `getInstance()` / `resetInstance()` for testing.

## Karpathy Rules (non-negotiable)

### Rule 1: Surface, Don't Hide
- State assumptions explicitly. If uncertain about ANYTHING, stop and ask — don't guess silently.
- When there are multiple valid approaches, present the 2 best options. Don't pick one silently.
- If asked to do something questionable, push back and explain why. Don't comply blindly.

### Rule 2: Minimum Code, Maximum Clarity
- Solve the problem with the fewest lines possible. If 200 lines could be 50, rewrite it.
- No speculative features. No "future-proofing" abstractions. No error handling for impossible states.
- Hard rule: 3 similar lines beats a premature abstraction. Every time.

### Rule 3: Surgical Precision
- Touch ONLY the lines that trace directly to the user's request.
- Do NOT fix adjacent formatting, comments, or variable names "while you're there."
- Do NOT delete pre-existing dead code or comments — mention it, let the user decide.
- Match existing code style exactly. Even if you'd write it differently. Consistency > your preference.

### Rule 4: Verify, Don't Assume
- Every task ends with a verifiable outcome. "It should work" is not verification.
- After changing code, prove it works: build + run + see result. No evidence = not done.

### Rule 5: Three-Pass Minimum
1. **Inline check** — every changed line must have a reason.
2. **Cross-file check** — grep affected symbols, verify types and consumers.
3. **Runtime path check** — trace full call chain from entry to exit. For distributed/cross-layer systems, include concurrency reasoning: "what if two of these run at the same time?"

If Pass 3 reveals a gap, fix it and restart from Pass 1. Three clean passes required.

## The Gate — invoke skills BEFORE action

Every user request passes through The Gate:

```
→ Bug/unexpected behavior? → systematic-debugging FIRST
→ Creative/frontend/UI?    → brainstorming FIRST
→ Feature or fix?          → test-driven-development FIRST
→ 3+ files / architectural?→ writing-plans FIRST
→ About to claim done?     → verification-before-completion FIRST
```

If you think "this is just a simple fix" or "a skill is overkill" — STOP. Simple fixes cause the worst regressions.

## Build Gate (non-negotiable)

After EVERY code change: build until zero errors. No build = not done. Do not claim completion with a failing build.

## Integration Gate (non-negotiable)

Writing code ≠ shipping code. If it's not wired into the system, it doesn't exist.

- **Every new file must have a caller**: new tool → ToolRegistry registration; new route/handler → router registration; new WS handler → handler registration; new component/page → parent import/render. If you can't find where to wire it, STOP and ask.
- **"Unused" ≠ "Dead code"**: before deleting anything, grep for imports, string references, and dynamic auto-registration patterns. If any answer is "yes" or "maybe" — do NOT delete. Report to the user.
- **Before ending a session**, output a `## Pending Integrations` section listing anything unwired (or "None. All code is integrated.").
- **Never auto-delete** during cleanup/review tasks — present candidates to the user and wait for confirmation.

## Report Format

Lead with outcome, not process. No file paths dump, no jargon.

```
[Done / Fixed / Added] — one line summary.

What changed: 2-3 sentences max, plain English.

Result: Build status + any caveats.
```
