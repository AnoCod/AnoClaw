import * as fs from 'fs';
import * as path from 'path';
import type {
  CapabilityPluginRecommendation,
  CapabilityPluginRecommendationAction,
  CapabilityPluginRecommendationReason,
  CapabilityPluginRecommendationStatus,
  CapabilityRecord,
} from '../../../shared/types/capability.js';
import { PluginHostManager } from '../plugin-host/PluginHostManager.js';
import type { PluginListItem } from '../plugin-host/PluginRPC.js';

interface MarketplacePlugin {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  publisher?: string;
  category?: string;
  tags?: string[];
  installUrl?: string;
  capabilities?: string[];
  tools?: string[];
}

export interface CapabilityPluginRecommendationRequest {
  capability: CapabilityRecord;
  recommendedPlugins: string[];
  missingTools: string[];
}

export class CapabilityPluginRecommender {
  async recommend(request: CapabilityPluginRecommendationRequest): Promise<CapabilityPluginRecommendation[]> {
    const [plugins, marketplace] = await Promise.all([
      this._loadInstalledPlugins(),
      this._loadMarketplacePlugins(),
    ]);

    return buildPluginRecommendations(request, plugins, marketplace);
  }

  private async _loadInstalledPlugins(): Promise<PluginListItem[]> {
    try {
      return await PluginHostManager.getInstance().listPlugins();
    } catch {
      return [];
    }
  }

  private async _loadMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    const filePath = path.resolve(process.cwd(), 'plugins-market.json');
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { plugins?: MarketplacePlugin[] };
      return Array.isArray(data.plugins) ? data.plugins : [];
    } catch {
      return [];
    }
  }
}

export function buildPluginRecommendations(
  request: CapabilityPluginRecommendationRequest,
  installedPlugins: PluginListItem[],
  marketplacePlugins: MarketplacePlugin[],
): CapabilityPluginRecommendation[] {
  const pluginNames = collectPluginNames(request, installedPlugins, marketplacePlugins);
  return pluginNames.map((pluginName) => {
    const installed = installedPlugins.find((plugin) => plugin.name === pluginName);
    const market = marketplacePlugins.find((plugin) => plugin.name === pluginName);
    return buildPluginRecommendation(request, pluginName, installed, market);
  });
}

function collectPluginNames(
  request: CapabilityPluginRecommendationRequest,
  installedPlugins: PluginListItem[],
  marketplacePlugins: MarketplacePlugin[],
): string[] {
  const names = new Set<string>();
  for (const name of request.recommendedPlugins) names.add(name);
  if (request.capability.pluginName) names.add(request.capability.pluginName);

  for (const plugin of installedPlugins) {
    if (pluginProvidesCapability(plugin, request.capability.id)) names.add(plugin.name);
    if (pluginProvidesTools(plugin, request.missingTools)) names.add(plugin.name);
  }

  for (const plugin of marketplacePlugins) {
    if (marketProvidesCapability(plugin, request.capability.id)) names.add(plugin.name);
    if (marketProvidesTools(plugin, request.missingTools)) names.add(plugin.name);
  }

  return Array.from(names).filter(Boolean);
}

function buildPluginRecommendation(
  request: CapabilityPluginRecommendationRequest,
  pluginName: string,
  installed: PluginListItem | undefined,
  market: MarketplacePlugin | undefined,
): CapabilityPluginRecommendation {
  const status = resolveStatus(installed);
  const reason = resolveReason(request, pluginName, installed, market, status);
  const action = resolveAction(status, Boolean(market?.installUrl), reason);
  const source = resolveSource(installed, market);

  return {
    pluginName,
    displayName: installed?.displayName || market?.displayName || pluginName,
    status,
    action,
    reason,
    source,
    installable: status === 'missing' && Boolean(market?.installUrl),
    missingTools: request.missingTools,
    version: installed?.version || market?.version,
    publisher: installed?.publisher || market?.publisher,
    description: installed?.description || market?.description,
    installUrl: market?.installUrl,
    installRoute: market?.installUrl ? '/api/v1/plugins/install' : undefined,
    activateRoute: status === 'installed' ? '/api/v1/plugins/reload' : undefined,
    errorMessage: installed?.errorMessage,
  };
}

function resolveStatus(installed: PluginListItem | undefined): CapabilityPluginRecommendationStatus {
  if (!installed) return 'missing';
  if (installed.status === 'activated') return 'activated';
  if (installed.status === 'error') return 'error';
  if (installed.status === 'loaded') return 'installed';
  return 'unknown';
}

function resolveAction(
  status: CapabilityPluginRecommendationStatus,
  hasInstallUrl: boolean,
  reason: CapabilityPluginRecommendationReason,
): CapabilityPluginRecommendationAction {
  if (status === 'installed') return 'activate';
  if (status === 'missing' && hasInstallUrl) return 'install';
  if (status === 'error') return 'inspect';
  if (status === 'activated' && reason === 'missing_tools') return 'reload';
  return 'none';
}

function resolveReason(
  request: CapabilityPluginRecommendationRequest,
  pluginName: string,
  installed: PluginListItem | undefined,
  market: MarketplacePlugin | undefined,
  status: CapabilityPluginRecommendationStatus,
): CapabilityPluginRecommendationReason {
  if (status === 'error') return 'plugin_error';
  if (status === 'installed') return 'plugin_not_active';
  if (installed && pluginProvidesCapability(installed, request.capability.id)) return 'capability_provider';
  if (installed && pluginProvidesTools(installed, request.missingTools)) return 'missing_tools';
  if (market && marketProvidesCapability(market, request.capability.id)) return 'capability_provider';
  if (market && marketProvidesTools(market, request.missingTools)) return 'missing_tools';
  if (request.capability.pluginName === pluginName) return 'capability_provider';
  return 'recommended';
}

function resolveSource(
  installed: PluginListItem | undefined,
  market: MarketplacePlugin | undefined,
): CapabilityPluginRecommendation['source'] {
  if (installed) return 'local';
  if (market?.tags?.some((tag) => tag.toLowerCase() === 'official') || market?.publisher === 'anoclaw') {
    return 'official';
  }
  if (market) return 'marketplace';
  return 'unknown';
}

function pluginProvidesCapability(plugin: PluginListItem, capabilityId: string): boolean {
  return Boolean(plugin.contributes?.capabilities?.some((capability) => capability.id === capabilityId));
}

function pluginProvidesTools(plugin: PluginListItem, missingTools: string[]): boolean {
  if (missingTools.length === 0) return false;
  const toolNames = new Set((plugin.contributes?.tools || []).map((tool) => tool.name).filter(Boolean));
  return missingTools.some((toolName) => toolNames.has(toolName));
}

function marketProvidesCapability(plugin: MarketplacePlugin, capabilityId: string): boolean {
  return Boolean(plugin.capabilities?.includes(capabilityId));
}

function marketProvidesTools(plugin: MarketplacePlugin, missingTools: string[]): boolean {
  if (missingTools.length === 0) return false;
  const toolNames = new Set(plugin.tools || []);
  return missingTools.some((toolName) => toolNames.has(toolName));
}
