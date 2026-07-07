// registerAllRoutes — registers all declarative HTTP routes with ApiServer

import type { ApiServer } from '../ApiServer.js';
import { HealthRoute } from './HealthRoute.js';
import { ToolsListRoute, CommandsListRoute, ToolsStatsRoute } from './ToolsRoute.js';
import { ListCapabilitiesRoute, ResolveTaskRoute } from './CapabilityRoutes.js';
import { ToolsGroupRoute } from './ToolsGroupRoute.js';
import { GetToolDetailRoute, ToolsForAgentRoute } from './ToolsDetailRoute.js';
import { OpenFileRoute, StatsRoute, GetLogEntriesRoute } from './SystemRoutes.js';
import { SystemInfoRoute } from './SystemInfoRoute.js';
import { GetSettingsRoute, PutSettingsRoute } from './SettingsRoutes.js';
import { GetSettingsRoute as GetFullSettingsRoute, PutSettingRoute } from './SettingsFullRoute.js';
import { AgentOrgTreeRoute } from './AgentOrgTreeRoute.js';
import { SetAgentStateRoute, ReassignAgentParentRoute, AgentReportChainRoute, FindAgentRoute, ReloadAgentsRoute, ListAgentsFilteredRoute } from './AgentControlRoutes.js';
import { GetSessionTreeRoute, GetSessionSubtreeRoute } from './SessionTreeRoutes.js';
import { InterruptSessionRoute, InterruptStatusRoute, SessionMetadataRoute, SessionParentRoute, SessionRootRoute, ActiveSessionRoute, SetActiveSessionRoute, SessionGarbageCollectRoute, HardDeleteSessionRoute, SessionListFilteredRoute } from './SessionControlRoutes.js';
import { BackgroundTasksRoute } from './BackgroundTaskRoute.js';
import { MemorySearchRoute } from './MemorySearchRoute.js';
import { MemoryExtractRoute } from './MemoryExtractRoute.js';
import { ListMemoryRoute, CreateMemoryRoute, UpdateMemoryRoute, DeleteMemoryRoute } from './MemoryCrudRoutes.js';
import { PluginDetailRoute } from './PluginDetailRoute.js';
import { ListPluginStorageRoute, GetPluginStorageRoute, PutPluginStorageRoute } from './PluginStorageRoutes.js';
import { GetPluginConfigRoute, PutPluginConfigRoute } from './PluginConfigRoutes.js';
import { PluginExtensionsRoute, PluginHostStatusRoute } from './PluginDiagnosticRoutes.js';
import { LogSearchRoute, PutLogLevelRoute } from './LogRoutes.js';
import { PreviewAgentPromptRoute, PromptCacheStatsRoute, ClearPromptCacheRoute, GetCustomCLIRoute, SetCustomCLIRoute, PromptSectionsRoute } from './PromptRoutes.js';
import { ListSkillsRoute, GetSkillRoute, ReloadSkillsRoute, AutoGenerateSkillRoute, SkillsForAgentRoute, CreateSkillRoute, PatchSkillRoute, DeleteSkillRoute } from './SkillsRoutes.js';
import { WsConnectionsRoute, WsBroadcastRoute, WsDisconnectRoute } from './WsRoutes.js';
import { WorkspaceInfoRoute } from './WorkspaceRoute.js';
import {
  GetWorkspaceRoute, BindWorkspaceRoute, BrowseWorkspaceRoute, ReadWorkspaceFileRoute,
  CreateWorkspaceDirRoute, CreateWorkspaceFileRoute, DeleteWorkspaceFileRoute,
  RenameWorkspaceFileRoute, MoveWorkspaceFileRoute, WriteWorkspaceFileRoute,
  ConvertOfficeRoute,
} from './WorkspaceRoutes.js';
import { EvolutionAnalyzeRoute, EvolutionApplyRoute, EvolutionStatsRoute } from './EvolutionRoute.js';
import { AgentExecuteRoute, AgentExecuteRedirectRoute } from './AgentExecuteRoute.js';
import { SessionMessageRoute, SessionMessageRedirectRoute } from './SessionMessageRoute.js';
import { ToolExecuteRoute, ToolExecuteRedirectRoute } from './ToolExecuteRoute.js';
import { SkillExecuteRoute, SkillExecuteRedirectRoute } from './SkillExecuteRoute.js';
import {
  ListGroupsRoute, CreateGroupRoute, UpdateGroupRoute, DeleteGroupRoute,
  ListTemplatesRoute, GetTemplateRoute, CreateTemplateRoute, DeleteTemplateRoute, HireTemplateRoute,
} from './TalentPoolRoutes.js';
import { InlineSuggestRoute } from './InlineSuggestRoute.js';
import {
  ListSessionsRoute, CreateSessionRoute, SearchSessionsRoute,
  GetSessionRoute, PatchSessionRoute, DeleteSessionRoute, ClearSessionsRoute,
  SessionOverviewRoute, SessionToolStatsRoute, SessionAutoTitleRoute,
} from './SessionRoutes.js';
import {
  ListAgentsRoute, GetAgentRoute, CreateAgentRoute,
  UpdateAgentRoute, DeleteAgentRoute, AgentStatusRoute, TestAgentConnectionRoute,
} from './AgentRoutes.js';

export function registerAllRoutes(api: ApiServer): void {
  // System
  api.registerRoute(new HealthRoute());
  api.registerRoute(new SystemInfoRoute());
  api.registerRoute(new StatsRoute());
  api.registerRoute(new GetLogEntriesRoute());
  api.registerRoute(new OpenFileRoute());

  // Settings
  api.registerRoute(new GetSettingsRoute());
  api.registerRoute(new PutSettingsRoute());
  api.registerRoute(new GetFullSettingsRoute());
  api.registerRoute(new PutSettingRoute());

  // Tools & Commands — specific paths BEFORE parameterized /tools/:name
  api.registerRoute(new ToolsListRoute());
  api.registerRoute(new CommandsListRoute());
  api.registerRoute(new ListCapabilitiesRoute());
  api.registerRoute(new ResolveTaskRoute());
  api.registerRoute(new ToolsGroupRoute());
  api.registerRoute(new ToolsStatsRoute());
  api.registerRoute(new GetToolDetailRoute());
  api.registerRoute(new ToolsForAgentRoute());

  // Agents — legacy CRUD
  api.registerRoute(new ListAgentsRoute());
  api.registerRoute(new CreateAgentRoute());
  api.registerRoute(new TestAgentConnectionRoute());
  api.registerRoute(new GetAgentRoute());
  api.registerRoute(new UpdateAgentRoute());
  api.registerRoute(new DeleteAgentRoute());
  api.registerRoute(new AgentStatusRoute());

  // Agents — control
  api.registerRoute(new AgentOrgTreeRoute());
  api.registerRoute(new SetAgentStateRoute());
  api.registerRoute(new ReassignAgentParentRoute());
  api.registerRoute(new AgentReportChainRoute());
  api.registerRoute(new FindAgentRoute());
  api.registerRoute(new ReloadAgentsRoute());
  api.registerRoute(new ListAgentsFilteredRoute());
  api.registerRoute(new PreviewAgentPromptRoute());

  // Sessions — legacy CRUD
  api.registerRoute(new ListSessionsRoute());
  api.registerRoute(new CreateSessionRoute());
  api.registerRoute(new GetSessionRoute());
  api.registerRoute(new PatchSessionRoute());
  api.registerRoute(new DeleteSessionRoute());
  api.registerRoute(new ClearSessionsRoute());
  api.registerRoute(new SessionOverviewRoute());
  api.registerRoute(new SessionToolStatsRoute());
  api.registerRoute(new SessionAutoTitleRoute());

  // Sessions — control
  api.registerRoute(new GetSessionTreeRoute());
  api.registerRoute(new GetSessionSubtreeRoute());
  api.registerRoute(new InterruptSessionRoute());
  api.registerRoute(new InterruptStatusRoute());
  api.registerRoute(new SessionMetadataRoute());
  api.registerRoute(new SessionParentRoute());
  api.registerRoute(new SessionRootRoute());
  api.registerRoute(new ActiveSessionRoute());
  api.registerRoute(new SetActiveSessionRoute());
  api.registerRoute(new SessionGarbageCollectRoute());
  api.registerRoute(new HardDeleteSessionRoute());
  api.registerRoute(new SessionListFilteredRoute());
  api.registerRoute(new BackgroundTasksRoute());

  // Memory
  api.registerRoute(new MemorySearchRoute());
  api.registerRoute(new MemoryExtractRoute());
  api.registerRoute(new ListMemoryRoute());
  api.registerRoute(new CreateMemoryRoute());
  api.registerRoute(new UpdateMemoryRoute());
  api.registerRoute(new DeleteMemoryRoute());

  // Search
  api.registerRoute(new SearchSessionsRoute());

  // Plugins — register specific paths BEFORE parameterized ones
  api.registerRoute(new PluginExtensionsRoute());
  api.registerRoute(new PluginHostStatusRoute());
  api.registerRoute(new PluginDetailRoute());
  api.registerRoute(new ListPluginStorageRoute());
  api.registerRoute(new GetPluginStorageRoute());
  api.registerRoute(new PutPluginStorageRoute());
  api.registerRoute(new GetPluginConfigRoute());
  api.registerRoute(new PutPluginConfigRoute());
  // Logs
  api.registerRoute(new LogSearchRoute());
  api.registerRoute(new PutLogLevelRoute());

  // Prompt
  api.registerRoute(new PromptCacheStatsRoute());
  api.registerRoute(new ClearPromptCacheRoute());
  api.registerRoute(new GetCustomCLIRoute());
  api.registerRoute(new SetCustomCLIRoute());
  api.registerRoute(new PromptSectionsRoute());

  // Skills
  api.registerRoute(new ListSkillsRoute());
  api.registerRoute(new GetSkillRoute());
  api.registerRoute(new ReloadSkillsRoute());
  api.registerRoute(new AutoGenerateSkillRoute());
  api.registerRoute(new SkillsForAgentRoute());
  api.registerRoute(new CreateSkillRoute());
  api.registerRoute(new PatchSkillRoute());
  api.registerRoute(new DeleteSkillRoute());

  // WebSocket
  api.registerRoute(new WsConnectionsRoute());
  api.registerRoute(new WsBroadcastRoute());
  api.registerRoute(new WsDisconnectRoute());

  // Workspace
  api.registerRoute(new WorkspaceInfoRoute());
  api.registerRoute(new GetWorkspaceRoute());
  api.registerRoute(new BindWorkspaceRoute());
  api.registerRoute(new BrowseWorkspaceRoute());
  api.registerRoute(new ReadWorkspaceFileRoute());
  api.registerRoute(new CreateWorkspaceDirRoute());
  api.registerRoute(new CreateWorkspaceFileRoute());
  api.registerRoute(new DeleteWorkspaceFileRoute());
  api.registerRoute(new RenameWorkspaceFileRoute());
  api.registerRoute(new MoveWorkspaceFileRoute());
  api.registerRoute(new WriteWorkspaceFileRoute());
  api.registerRoute(new ConvertOfficeRoute());

  // Evolution
  api.registerRoute(new EvolutionStatsRoute());
  api.registerRoute(new EvolutionAnalyzeRoute());
  api.registerRoute(new EvolutionApplyRoute());

  // Agent — general-purpose agent execution for plugins
  api.registerRoute(new AgentExecuteRoute());
  api.registerRoute(new AgentExecuteRedirectRoute());

  // Session — message injection
  api.registerRoute(new SessionMessageRoute());
  api.registerRoute(new SessionMessageRedirectRoute());

  // Tool — generic tool execution
  api.registerRoute(new ToolExecuteRoute());
  api.registerRoute(new ToolExecuteRedirectRoute());

  // Skill — load and execute skills
  api.registerRoute(new SkillExecuteRoute());
  api.registerRoute(new SkillExecuteRedirectRoute());

  // Talent Pool
  api.registerRoute(new ListGroupsRoute());
  api.registerRoute(new CreateGroupRoute());
  api.registerRoute(new UpdateGroupRoute());
  api.registerRoute(new DeleteGroupRoute());
  api.registerRoute(new ListTemplatesRoute());
  api.registerRoute(new GetTemplateRoute());
  api.registerRoute(new CreateTemplateRoute());
  api.registerRoute(new DeleteTemplateRoute());
  api.registerRoute(new HireTemplateRoute());

  // Inline code completion
  api.registerRoute(new InlineSuggestRoute());

  // Non-declarative endpoints (not backed by RouteHandler — for discovery only)
  const R = (m: string, p: string, d: string, c?: string) => api.registerNonDeclarativeEndpoint(m, p, d, c);
  R('GET', '/api/v1/endpoints', 'Discover all API endpoints (this list)', 'System');
  R('GET', '/api/v1/sessions/:id/messages', 'Read session message history', 'Sessions');
  R('POST', '/api/v1/sessions/:id/messages', 'Send message (triggers Agent execution)', 'Sessions');
  // Memory routes (legacy MemoryRoutes class)
  R('GET', '/api/v1/memory', 'List all memory entries', 'Memory');
  R('POST', '/api/v1/memory', 'Create a new memory entry', 'Memory');
  R('PATCH', '/api/v1/memory/:id', 'Update a memory entry', 'Memory');
  R('DELETE', '/api/v1/memory/:id', 'Delete a memory entry', 'Memory');
  // Plugin management (dispatched via _dispatchPluginRoute)
  R('GET', '/api/v1/plugins', 'List all plugins', 'Plugins');
  R('POST', '/api/v1/plugins/reload', 'Reload a plugin', 'Plugins');
  R('DELETE', '/api/v1/plugins/:name', 'Uninstall plugin', 'Plugins');
}
