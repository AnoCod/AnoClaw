import type {
  CapabilityAvailability,
  CapabilityDefinition,
  CapabilityListFilters,
  CapabilityRecord,
  CapabilitySource,
} from '../../../shared/types/capability.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { PluginHostManager } from '../plugin-host/PluginHostManager.js';
import type { PluginListItem } from '../plugin-host/PluginRPC.js';
import { createDefaultCapabilityCatalog } from './DefaultCapabilities.js';

export interface CapabilityListOptions {
  includeUnavailable?: boolean;
  search?: string;
  domain?: string;
  status?: CapabilityAvailability;
  source?: CapabilitySource;
  limit?: number;
}

interface RuntimeCapabilityProvider {
  source: Exclude<CapabilitySource, 'catalog'>;
  sourceName: string;
  pluginName?: string;
  pluginStatus?: string;
  capabilities: CapabilityDefinition[];
}

interface RuntimeCapabilityOptions {
  source?: Exclude<CapabilitySource, 'catalog'>;
  pluginName?: string;
  pluginStatus?: string;
}

export class CapabilityRegistry {
  private static _instance: CapabilityRegistry | null = null;

  static getInstance(): CapabilityRegistry {
    if (!this._instance) this._instance = new CapabilityRegistry();
    return this._instance;
  }

  static resetInstance(): void {
    this._instance = null;
  }

  private _catalog: CapabilityDefinition[] = createDefaultCapabilityCatalog();
  private _runtimeProviders = new Map<string, RuntimeCapabilityProvider>();

  setCatalogCapabilities(capabilities: CapabilityDefinition[]): void {
    this._catalog = capabilities.map(normalizeDefinition);
  }

  registerRuntimeCapabilities(
    sourceName: string,
    capabilities: CapabilityDefinition[],
    options: RuntimeCapabilityOptions = {},
  ): void {
    this._runtimeProviders.set(sourceName, {
      source: options.source || 'plugin',
      sourceName,
      pluginName: options.pluginName,
      pluginStatus: options.pluginStatus,
      capabilities: capabilities.map(normalizeDefinition),
    });
  }

  clearRuntimeCapabilities(sourceName?: string): void {
    if (sourceName) this._runtimeProviders.delete(sourceName);
    else this._runtimeProviders.clear();
  }

  async allCapabilities(options: CapabilityListOptions = {}): Promise<{
    capabilities: CapabilityRecord[];
    total: number;
    availableTotal: number;
    filters: CapabilityListFilters;
  }> {
    const limit = clampLimit(options.limit, 200, 500);
    const records = await this._collectRecords();
    const availableTotal = records.filter((capability) => capability.status === 'available').length;
    const filtered = filterCapabilities(records, { ...options, limit });

    return {
      capabilities: filtered.slice(0, limit),
      total: filtered.length,
      availableTotal,
      filters: compactFilters(options, limit),
    };
  }

  async findById(id: string): Promise<CapabilityRecord | undefined> {
    const records = await this._collectRecords();
    return records.find((capability) => capability.id === id);
  }

  private async _collectRecords(): Promise<CapabilityRecord[]> {
    const records: CapabilityRecord[] = [];

    for (const capability of this._catalog) {
      records.push(this._decorate(capability, {
        source: 'catalog',
        sourceName: 'anoclaw.default',
      }));
    }

    for (const provider of this._runtimeProviders.values()) {
      for (const capability of provider.capabilities) {
        records.push(this._decorate(capability, provider));
      }
    }

    for (const plugin of await this._loadPluginManifestCapabilities()) {
      const capabilities = plugin.contributes?.capabilities || [];
      for (const capability of capabilities) {
        records.push(this._decorate(capability, {
          source: 'plugin',
          sourceName: plugin.name,
          pluginName: plugin.name,
          pluginStatus: plugin.status,
        }));
      }
    }

    return sortCapabilities(dedupeByBestProvider(records));
  }

  private async _loadPluginManifestCapabilities(): Promise<PluginListItem[]> {
    try {
      return await PluginHostManager.getInstance().listPlugins();
    } catch {
      return [];
    }
  }

  private _decorate(
    rawCapability: CapabilityDefinition,
    provider: {
      source: CapabilitySource;
      sourceName: string;
      pluginName?: string;
      pluginStatus?: string;
    },
  ): CapabilityRecord {
    const capability = normalizeDefinition(rawCapability);
    const requiredTools = capability.requiredTools || capability.tools || [];
    const missingTools = requiredTools.filter((toolName) => !ToolRegistry.getInstance().hasTool(toolName));
    const status = resolveAvailability(provider.source, provider.pluginStatus, missingTools);

    return {
      ...capability,
      source: provider.source,
      sourceName: provider.sourceName,
      status,
      missingTools,
      pluginName: provider.pluginName,
      pluginStatus: provider.pluginStatus,
    };
  }
}

function normalizeDefinition(capability: CapabilityDefinition): CapabilityDefinition {
  return {
    ...capability,
    kind: capability.kind || 'utility',
    triggers: Array.isArray(capability.triggers) ? capability.triggers.filter(Boolean) : [],
    examples: Array.isArray(capability.examples) ? capability.examples.filter(Boolean) : [],
    inputs: Array.isArray(capability.inputs) ? capability.inputs : [],
    outputs: Array.isArray(capability.outputs) ? capability.outputs : [],
    tools: Array.isArray(capability.tools) ? capability.tools.filter(Boolean) : undefined,
    requiredTools: Array.isArray(capability.requiredTools) ? capability.requiredTools.filter(Boolean) : undefined,
    skills: Array.isArray(capability.skills) ? capability.skills.filter(Boolean) : undefined,
    artifactTypes: Array.isArray(capability.artifactTypes) ? capability.artifactTypes.filter(Boolean) : undefined,
    recommendedPlugins: Array.isArray(capability.recommendedPlugins) ? capability.recommendedPlugins.filter(Boolean) : undefined,
    priority: capability.priority || 0,
  };
}

function resolveAvailability(
  source: CapabilitySource,
  pluginStatus: string | undefined,
  missingTools: string[],
): CapabilityAvailability {
  if (pluginStatus === 'error') return 'error';
  if (source === 'plugin' && pluginStatus && pluginStatus !== 'activated') return 'disabled';
  if (missingTools.length === 0) return 'available';
  return source === 'catalog' ? 'needs_plugin' : 'unavailable';
}

function dedupeByBestProvider(records: CapabilityRecord[]): CapabilityRecord[] {
  const byId = new Map<string, CapabilityRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing || compareProviderQuality(record, existing) < 0) {
      byId.set(record.id, record);
    }
  }
  return Array.from(byId.values());
}

function compareProviderQuality(a: CapabilityRecord, b: CapabilityRecord): number {
  const statusRank: Record<CapabilityAvailability, number> = {
    available: 0,
    disabled: 1,
    unavailable: 2,
    needs_plugin: 3,
    error: 4,
  };
  const statusDiff = statusRank[a.status] - statusRank[b.status];
  if (statusDiff !== 0) return statusDiff;
  const sourceRank: Record<CapabilitySource, number> = { plugin: 0, kernel: 1, catalog: 2 };
  const sourceDiff = sourceRank[a.source] - sourceRank[b.source];
  if (sourceDiff !== 0) return sourceDiff;
  return (b.priority || 0) - (a.priority || 0);
}

function sortCapabilities(records: CapabilityRecord[]): CapabilityRecord[] {
  return [...records].sort((a, b) => {
    const status = compareProviderQuality(a, b);
    if (status !== 0) return status;
    return a.title.localeCompare(b.title);
  });
}

function filterCapabilities(records: CapabilityRecord[], options: CapabilityListOptions): CapabilityRecord[] {
  const includeUnavailable = options.includeUnavailable !== false;
  const search = (options.search || '').trim().toLowerCase();
  const domain = (options.domain || '').trim().toLowerCase();
  const status = options.status;
  const source = options.source;

  return records.filter((capability) => {
    if (!includeUnavailable && capability.status !== 'available') return false;
    if (domain && capability.domain.toLowerCase() !== domain) return false;
    if (status && capability.status !== status) return false;
    if (source && capability.source !== source) return false;
    if (!search) return true;
    const terms = search.split(/\s+/).filter(Boolean);
    const haystack = capabilityHaystack(capability);
    return terms.every((term) => haystack.includes(term));
  });
}

function capabilityHaystack(capability: CapabilityRecord): string {
  return [
    capability.id,
    capability.title,
    capability.description || '',
    capability.domain,
    capability.kind || '',
    capability.sourceName,
    capability.status,
    ...(capability.triggers || []),
    ...(capability.examples || []),
    ...(capability.artifactTypes || []),
    ...(capability.outputs || []).flatMap((output) => [
      output.type,
      output.label || '',
      output.extension || '',
      output.artifactType || '',
    ]),
  ].join(' ').toLowerCase();
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function compactFilters(options: CapabilityListOptions, limit: number): CapabilityListFilters {
  const filters: CapabilityListFilters = { limit };
  if (options.search) filters.search = options.search;
  if (options.domain) filters.domain = options.domain;
  if (options.status) filters.status = options.status;
  if (options.source) filters.source = options.source;
  return filters;
}
