# 生态兼容桥（Ecosystem Bridge）

AnoClaw 可以**原位挂载** Codex、Claude Code、OpenClaw、OpenCode、Hermes 的技能、MCP、命令、代理与插件——不复制任何文件，来源目录始终是唯一事实源。核心实现在 `src/server/core/ecosystem/`，由内核加载（先于 PluginHost）；MCP 已原生化（`src/server/infra/mcp/McpManager.ts`，退役了 `anoclaw-mcp` 插件）。前端提供合并后的“技能与工具”页面（技能 + MCP + 生态兼容三个分区）。

## 支持矩阵

| 资产 | Codex | Claude Code | OpenClaw | OpenCode | Hermes |
| --- | --- | --- | --- | --- | --- |
| 技能 SKILL.md | native | native | native | native | native |
| MCP 服务器 | native | native | native | native | native |
| 插件（声明式部分） | native | native | partial | bridge | unsupported |
| 命令（slash command） | – | native | native | native | – |
| 代理（agent markdown） | – | partial | – | partial | – |
| 钩子 hooks | partial | partial | partial | bridge | – |
| 项目规则 CLAUDE.md/AGENTS.md | – | 仅列出 | – | 仅列出 | – |

说明：

- `native`：直接映射为 AnoClaw 原生能力（技能注册、MCP 插件存储、命令注册）。
- `bridge`：OpenCode JS/TS 插件在 Worker 中加载，工具注册进 ToolRegistry，事件映射到 TypedEventBus。
- `partial`：可映射的字段生效，其余字段跳过并在条目上给出警告。
- `unsupported`：Hermes 插件是 Python，v1 仅识别不执行。
- 钩子的**命令执行**默认不启用，只做事件映射与可见性。

## 扫描根目录

- Codex：`~/.codex/skills`、`~/.codex/plugins`、`~/.codex/config.toml`、项目 `.mcp.json`、`~/.agents/plugins/marketplace.json` 与项目 `.agents/plugins/marketplace.json`。
- Claude Code：项目与用户的 `.claude/skills`、`.claude/commands`、`.claude/plugins`、项目 `.mcp.json`、`~/.claude.json`。
- OpenClaw：`<workspace>/skills`、`.agents/skills`、`~/.agents/skills`、`~/.openclaw/skills`、`openclaw.json`（`mcp.servers`）、`~/.openclaw/plugins`。
- OpenCode：项目与全局 `.opencode/skills`、`opencode.json[c]`（`mcp`、`plugin`）、`.opencode/plugins`、`.opencode/agents`、`.opencode/commands`。
- Hermes：`~/.hermes/skills`（含分类子目录）、配置文件中的 `mcp_servers` YAML 块、`~/.hermes/plugins`。

## 使用流程

1. 打开“生态兼容”页面，点击“扫描预览”（只读，不挂载）。
2. 每个条目默认 `discovered`，点击开关才会启用；代码插件（OpenCode/OpenClaw 运行时）需先点“信任”。
3. “同步挂载”重新扫描并挂载所有已启用的条目。
4. “遗忘”只移除注册与状态，不删除任何源文件。

## 命名与冲突

挂载后的技能、命令默认使用 `生态:原名`（如 `openclaw:image-lab`）避免跨生态冲突。`data/ecosystem.json` 中可对单个条目开启 `cleanName`，仅在无冲突时使用原名。

## 安全模型

- 扫描结果一律不自动启用；显式 enable 才挂载。
- 含内嵌 shell（`!cmd` / ` ```! ````）的技能会被标记；代码插件默认不可启用，需信任审核。
- MCP 配置中的环境变量占位符（`${env:X}`、`${X}`、`{env:X}`）在导入时解析；缺失变量保留字面量并给出 warning；密钥值不写日志。
- OpenClaw `metadata.openclaw.requires` 与 Hermes `platforms` / `requires_tools*` 门控在挂载时评估，不满足的条目标记为 error/disabled。

## API

- `GET /api/v1/ecosystem/overview` — 概览（分生态、根目录、条目）
- `GET /api/v1/ecosystem/scan` — 只读扫描预览
- `POST /api/v1/ecosystem/sync` — 重新扫描并挂载已启用条目
- `POST /api/v1/ecosystem/entries/:id/enable|disable|trust`
- `DELETE /api/v1/ecosystem/entries/:id` — 遗忘（不删源文件）

## 状态与持久化

- `data/ecosystem.json`：每个条目的 enabled/trusted/cleanName/status/lastSyncedAt；运行时状态，不入库。
- MCP 导入会写入原生 `data/mcp-servers.json`（由 `McpManager.replaceImportedServers` 合并），并保留 `origin.entryId` 以便同步时安全替换；手动添加的服务器永远不会被覆盖。
- 代理（agent）是运行时注册（`AgentRegistry.registerAgent`），不写入 `data/agents/`，重启后由已启用的生态条目自动重建。

## 依赖

唯一新增运行时依赖：`smol-toml`（解析 Codex `config.toml`）。热同步使用 Node 原生 `fs.watch`（1 秒防抖，可在 `data/ecosystem.json` 中关闭）。
