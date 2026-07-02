# src/server/gateway/routes — Declarative Route Handlers

## Overview

32 `RouteHandler` implementations organized by category. All routes are registered centrally in `registerAllRoutes.ts` and dispatched by `ApiServer`'s declarative route table before the legacy if-else chain. This is the preferred pattern for new endpoints.

## Route File Catalog

### System (3 routes)
| File | Route(s) | Path |
|------|----------|------|
| `HealthRoute.ts` | `HealthRoute` | `GET /api/v1/health` |
| `SystemInfoRoute.ts` | `SystemInfoRoute` | `GET /api/v1/system/info` |
| `SystemRoutes.ts` | `OpenFileRoute` | `POST /api/v1/system/open-file` |

### Settings (2 routes)
| File | Route(s) | Path |
|------|----------|------|
| `SettingsRoutes.ts` | `GetSettingsRoute` | `GET /api/v1/settings/ui` |
| | `PutSettingsRoute` | `PUT /api/v1/settings/ui` |
| `SettingsFullRoute.ts` | `GetSettingsRoute` | `GET /api/v1/settings` |
| | `PutSettingRoute` | `PUT /api/v1/settings/:key` |

### Tools (5 routes)
| File | Route(s) | Path |
|------|----------|------|
| `ToolsRoute.ts` | `ToolsListRoute` | `GET /api/v1/tools` |
| | `CommandsListRoute` | `GET /api/v1/commands` |
| | `ToolsStatsRoute` | `GET /api/v1/tools/stats` |
| `ToolsGroupRoute.ts` | `ToolsGroupRoute` | `GET /api/v1/tools/groups` |
| `ToolsDetailRoute.ts` | `GetToolDetailRoute` | `GET /api/v1/tools/:name` |
| | `ToolsForAgentRoute` | `GET /api/v1/tools-for-agent/:agentId` |
| `ToolExecuteRoute.ts` | `ToolExecuteRoute` | `POST /api/v1/tool/execute` |

### Agents (8 routes)
| File | Route(s) | Path |
|------|----------|------|
| `AgentOrgTreeRoute.ts` | `AgentOrgTreeRoute` | `GET /api/v1/agents/tree` |
| `AgentControlRoutes.ts` | `SetAgentStateRoute` | `PATCH /api/v1/agents/:id/state` |
| | `ReassignAgentParentRoute` | `PATCH /api/v1/agents/:id/parent` |
| | `AgentReportChainRoute` | `GET /api/v1/agents/:id/report-chain` |
| | `FindAgentRoute` | `GET /api/v1/agents-find` |
| | `ReloadAgentsRoute` | `POST /api/v1/agents/reload` |
| | `ListAgentsFilteredRoute` | `GET /api/v1/agents-filtered` |
| `AgentExecuteRoute.ts` | `AgentExecuteRoute` | `POST /api/v1/agent/execute` |
| `PromptRoutes.ts` | `PreviewAgentPromptRoute` | `GET /api/v1/agents/:id/prompt` |

### Sessions (12 routes)
| File | Route(s) | Path |
|------|----------|------|
| `SessionTreeRoutes.ts` | `GetSessionTreeRoute` | `GET /api/v1/sessions/tree` |
| | `GetSessionSubtreeRoute` | `GET /api/v1/sessions/:id/tree` |
| `SessionControlRoutes.ts` | `InterruptSessionRoute` | `POST /api/v1/sessions/:id/interrupt` |
| | `InterruptStatusRoute` | `GET /api/v1/sessions/:id/interrupt-status` |
| | `SessionMetadataRoute` | `GET /api/v1/sessions/:id/metadata` |
| | `SessionParentRoute` | `GET /api/v1/sessions/:id/parent` |
| | `SessionRootRoute` | `GET /api/v1/sessions/:id/root` |
| | `ActiveSessionRoute` | `GET /api/v1/sessions-active` |
| | `SetActiveSessionRoute` | `POST /api/v1/sessions-active` |
| | `SessionGarbageCollectRoute` | `POST /api/v1/sessions/gc` |
| | `HardDeleteSessionRoute` | `DELETE /api/v1/sessions/:id/permanent` |
| | `SessionListFilteredRoute` | `GET /api/v1/sessions-filtered` |
| `SessionMessageRoute.ts` | `SessionMessageRoute` | `GET /api/v1/session/:id/messages` |
| `BackgroundTaskRoute.ts` | `BackgroundTasksRoute` | `GET /api/v1/sessions/:id/background-tasks` |

### Skills (9 routes)
| File | Route(s) | Path |
|------|----------|------|
| `SkillsRoutes.ts` | `ListSkillsRoute` | `GET /api/v1/skills` |
| | `GetSkillRoute` | `GET /api/v1/skills/:name` |
| | `ReloadSkillsRoute` | `POST /api/v1/skills/reload` |
| | `AutoGenerateSkillRoute` | `POST /api/v1/skills/auto-generate` |
| | `SkillsForAgentRoute` | `GET /api/v1/skills/for-agent/:agentId` |
| | `CreateSkillRoute` | `POST /api/v1/skills` |
| | `PatchSkillRoute` | `PATCH /api/v1/skills/:name` |
| | `DeleteSkillRoute` | `DELETE /api/v1/skills/:name` |
| `SkillExecuteRoute.ts` | `SkillExecuteRoute` | `POST /api/v1/skill/execute` |

### Memory (2 routes)
| File | Route(s) | Path |
|------|----------|------|
| `MemorySearchRoute.ts` | `MemorySearchRoute` | `POST /api/v1/memory/search` |
| `MemoryExtractRoute.ts` | `MemoryExtractRoute` | `POST /api/v1/memory/extract` |

**Legacy:** `MemoryRoutes.ts` — class-style handler (not `RouteHandler`), registered directly in `ApiServer`.

### Workspace (12 routes)
| File | Route(s) | Path |
|------|----------|------|
| `WorkspaceRoute.ts` | `WorkspaceInfoRoute` | `GET /api/v1/workspace` |
| `WorkspaceRoutes.ts` | `GetWorkspaceRoute` | `GET /api/v1/sessions/:id/workspace` |
| | `BindWorkspaceRoute` | `PATCH /api/v1/sessions/:id/bind-workspace` |
| | `BrowseWorkspaceRoute` | `GET /api/v1/workspace/browse` |
| | `ReadWorkspaceFileRoute` | `GET /api/v1/workspace/read` |
| | `CreateWorkspaceDirRoute` | `POST /api/v1/workspace/create-dir` |
| | `CreateWorkspaceFileRoute` | `POST /api/v1/workspace/create-file` |
| | `DeleteWorkspaceFileRoute` | `DELETE /api/v1/workspace/file` |
| | `RenameWorkspaceFileRoute` | `PATCH /api/v1/workspace/rename` |
| | `MoveWorkspaceFileRoute` | `POST /api/v1/workspace/move` |
| | `WriteWorkspaceFileRoute` | `PUT /api/v1/workspace/write` |
| | `ConvertOfficeRoute` | `GET /api/v1/workspace/convert-office` |

### Settings (2 routes — separate from SettingsRoutes)
| File | Route(s) | Path |
|------|----------|------|
| `SettingsRoutes.ts` | `GetSettingsRoute`, `PutSettingsRoute` | (UI settings) |
| `SettingsFullRoute.ts` | `GetSettingsRoute`, `PutSettingRoute` | (full config) |

### Plugin (8 routes)
| File | Route(s) | Path |
|------|----------|------|
| `PluginDetailRoute.ts` | `PluginDetailRoute` | `GET /api/v1/plugins/:name` |
| `PluginStorageRoutes.ts` | `ListPluginStorageRoute` | `GET /api/v1/plugins/:name/storage` |
| | `GetPluginStorageRoute` | `GET /api/v1/plugins/:name/storage/:key` |
| | `PutPluginStorageRoute` | `PUT /api/v1/plugins/:name/storage/:key` |
| `PluginConfigRoutes.ts` | `GetPluginConfigRoute` | `GET /api/v1/plugins/:name/config` |
| | `PutPluginConfigRoute` | `PUT /api/v1/plugins/:name/config` |
| `PluginDiagnosticRoutes.ts` | `PluginExtensionsRoute` | `GET /api/v1/plugins/extensions` |
| | `PluginHostStatusRoute` | `GET /api/v1/plugins/status` |

### System — Supplemental (6 routes)
| File | Route(s) | Path |
|------|----------|------|
| `LogRoutes.ts` | `LogSearchRoute` | `POST /api/v1/logs/search` |
| | `PutLogLevelRoute` | `PUT /api/v1/logs/level` |
| `PromptRoutes.ts` | `PromptCacheStatsRoute` | `GET /api/v1/prompt/cache-stats` |
| | `ClearPromptCacheRoute` | `POST /api/v1/prompt/clear-cache` |
| | `GetCustomCLIRoute` | `GET /api/v1/prompt/custom-cli` |
| | `SetCustomCLIRoute` | `PUT /api/v1/prompt/custom-cli` |
| | `PromptSectionsRoute` | `GET /api/v1/prompt/sections` |
| `WsRoutes.ts` | `WsConnectionsRoute` | `GET /api/v1/ws/connections` |
| | `WsBroadcastRoute` | `POST /api/v1/ws/broadcast` |
| | `WsDisconnectRoute` | `POST /api/v1/ws/connections/:sessionId` |

### Evolution (2 routes)
| File | Route(s) | Path |
|------|----------|------|
| `EvolutionRoute.ts` | `EvolutionAnalyzeRoute` | `POST /api/v1/evolution/analyze` |
| | `EvolutionApplyRoute` | `POST /api/v1/evolution/apply` |

---

## Registration

All routes are registered via `registerAllRoutes.ts`:

```ts
import { ApiServer } from '../ApiServer.js';
import { registerAllRoutes } from './routes/registerAllRoutes.js';

const api = ApiServer.getInstance();
registerAllRoutes(api);
```

The function calls `api.registerRoute(new RouteClass())` for all ~55 route instances. Static paths are registered before parameterized paths to prevent match ambiguity.

---

## Adding a New Route

```ts
// 1. Create a new file, e.g. PingRoute.ts
import { RouteHandler, RouteMatch } from '../RouteHandler.js';
import { sendJson } from '../RouteHelpers.js';
import type { ApiToken } from '../ApiAuth.js';

export class PingRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/ping';
  description = 'Simple ping check';
  category = 'System';

  handle(match: RouteMatch, req: any, res: any, token: ApiToken | null): boolean {
    sendJson(res, 200, { pong: true });
    return true;
  }
}

// 2. Register in registerAllRoutes.ts
import { PingRoute } from './PingRoute.js';
api.registerRoute(new PingRoute());
```

---

## Path Pattern Reference

| Pattern | Example | match.params |
|---------|---------|-------------|
| Static | `/api/v1/health` | `{}` |
| Single `:param` | `/api/v1/tools/:name` | `{ name: 'read_file' }` |
| Two `:param` | `/api/v1/plugins/:name/storage/:key` | `{ name: 'feishu', key: 'config' }` |

---

## Dependencies

All route files depend on:
- `RouteHandler.ts` — `RouteMatch` type + `matchRoute()` function
- `RouteHelpers.ts` — `sendJson()`, `readBody()`
- `ApiAuth.ts` — `ApiToken` type (type-only import)

Category-specific dependencies (core services) are imported directly within each route file.
