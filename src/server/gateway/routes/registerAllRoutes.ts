// registerAllRoutes — registers all declarative HTTP routes with ApiServer

import type { ApiServer } from '../ApiServer.js';
import { HealthRoute } from './HealthRoute.js';
import { ToolsListRoute, CommandsListRoute, ToolsStatsRoute } from './ToolsRoute.js';
import { ToolsGroupRoute } from './ToolsGroupRoute.js';
import { GetToolDetailRoute, ToolsForAgentRoute } from './ToolsDetailRoute.js';
import { OpenFileRoute } from './SystemRoutes.js';
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
import { AgentExecuteRoute } from './AgentExecuteRoute.js';
import { SessionMessageRoute } from './SessionMessageRoute.js';
import { ToolExecuteRoute } from './ToolExecuteRoute.js';
import { SkillExecuteRoute } from './SkillExecuteRoute.js';
import {
  ListGroupsRoute, CreateGroupRoute, UpdateGroupRoute, DeleteGroupRoute,
  ListTemplatesRoute, GetTemplateRoute, CreateTemplateRoute, DeleteTemplateRoute, HireTemplateRoute,
} from './TalentPoolRoutes.js';

export function registerAllRoutes(api: ApiServer): void {
  // System
  api.registerRoute(new HealthRoute());
  api.registerRoute(new SystemInfoRoute());
  api.registerRoute(new OpenFileRoute());

  // Settings
  api.registerRoute(new GetSettingsRoute());
  api.registerRoute(new PutSettingsRoute());
  api.registerRoute(new GetFullSettingsRoute());
  api.registerRoute(new PutSettingRoute());

  // Tools & Commands — specific paths BEFORE parameterized /tools/:name
  api.registerRoute(new ToolsListRoute());
  api.registerRoute(new CommandsListRoute());
  api.registerRoute(new ToolsGroupRoute());
  api.registerRoute(new ToolsStatsRoute());
  api.registerRoute(new GetToolDetailRoute());
  api.registerRoute(new ToolsForAgentRoute());

  // Agents
  api.registerRoute(new AgentOrgTreeRoute());
  api.registerRoute(new SetAgentStateRoute());
  api.registerRoute(new ReassignAgentParentRoute());
  api.registerRoute(new AgentReportChainRoute());
  api.registerRoute(new FindAgentRoute());
  api.registerRoute(new ReloadAgentsRoute());
  api.registerRoute(new ListAgentsFilteredRoute());
  api.registerRoute(new PreviewAgentPromptRoute());

  // Sessions
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

  // Session — message injection
  api.registerRoute(new SessionMessageRoute());

  // Tool — generic tool execution
  api.registerRoute(new ToolExecuteRoute());

  // Skill — load and execute skills
  api.registerRoute(new SkillExecuteRoute());

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
}
