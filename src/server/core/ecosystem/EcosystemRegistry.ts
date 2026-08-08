/**
 * EcosystemRegistry — live-mounts skills, MCP servers, commands, agents and
 * plugin bridges from Codex / Claude Code / OpenClaw / OpenCode / Hermes
 * without copying files. State is persisted to data/ecosystem.json.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { writablePath } from '../../infra/WritablePath.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { SkillManager } from '../skills/SkillManager.js';
import { SkillSource } from '../skills/Skill.js';
import { CommandRegistry } from '../commands/CommandRegistry.js';
import { Command } from '../commands/Command.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { Agent } from '../agent/Agent.js';
import { defaultConfig } from '../agent/AgentConfig.js';
import { AgentRole } from '../../../shared/types/agent.js';
import type { CommandResult } from '../../../shared/types/command.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { HermesAdapter } from './adapters/hermes.js';
import { parseSkillAsset } from './importers/skill-importer.js';
import { normalizeMcpServer, type McpServerConfig } from './importers/mcp-importer.js';
import { parseCommandAsset, type ImportedCommand } from './importers/command-importer.js';
import { parseAgentAsset, type ImportedAgent } from './importers/agent-importer.js';
import { loadHooksJson } from './importers/plugin-importer.js';
import { OpenCodePluginBridge } from './importers/opencode-bridge.js';
import { evaluateSkillGates } from './gates.js';
import {
  ECOSYSTEM_KINDS, ECOSYSTEM_LABELS, requiresTrustReview,
  type EcosystemAdapter, type EcosystemAsset, type EcosystemAssetType,
  type EcosystemEntryState, type EcosystemEntryView, type EcosystemKind,
  type EcosystemOverview, type EcosystemStateFile, type SupportLevel,
} from './types.js';

interface MountedRecord {
  entryId: string;
  assetType: EcosystemAssetType;
  names: string[];
  mcpConfig?: McpServerConfig;
  bridge?: OpenCodePluginBridge;
}

export interface EcosystemRegistryOptions {
  statePath?: string;
  /** Override MCP persistence (tests). Defaults to PluginStorage('anoclaw-mcp'). */
  mcpPersist?: (servers: McpServerConfig[]) => void | Promise<void>;
  watchEnabled?: boolean;
  /** Override adapters (tests). Defaults to the five real adapters. */
  adapters?: EcosystemAdapter[];
}

const STATE_VERSION = 1 as const;

function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function slug(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'item';
}

function entryId(asset: EcosystemAsset): string {
  return `${asset.kind}:${asset.assetType}:${slug(asset.name)}:${djb2(asset.sourcePath)}`;
}

/** Imported slash command backed by markdown instructions. */
class EcosystemMarkdownCommand extends Command {
  private _imported: ImportedCommand;
  private _mountName: string;

  constructor(imported: ImportedCommand, mountName: string) {
    super();
    this._imported = imported;
    this._mountName = mountName;
  }

  name(): string { return this._mountName; }
  displayName(): string { return this._imported.name; }
  description(): string { return this._imported.description; }
  category(): 'help' { return 'help'; }

  async execute(args: Record<string, string>, _ctx: ExecutionContext): Promise<CommandResult> {
    const argHint = this._imported.argumentHint ? `\n\nArgument hint: ${this._imported.argumentHint}` : '';
    return {
      success: true,
      command: this._mountName,
      output: `${this._imported.description}\n\n${this._imported.body}${argHint}`,
      durationMs: 0,
    };
  }
}

export class EcosystemRegistry extends EventEmitter {
  private static _instance: EcosystemRegistry | null = null;

  static getInstance(options?: EcosystemRegistryOptions): EcosystemRegistry {
    if (!EcosystemRegistry._instance) {
      EcosystemRegistry._instance = new EcosystemRegistry(options ?? {});
    }
    return EcosystemRegistry._instance;
  }

  static resetInstance(): void {
    EcosystemRegistry._instance = null;
  }

  private _options: Required<Pick<EcosystemRegistryOptions, 'statePath'>> & EcosystemRegistryOptions;
  private _state: EcosystemStateFile;
  private _adapters: EcosystemAdapter[];
  private _assets = new Map<string, EcosystemAsset>();
  private _views = new Map<string, EcosystemEntryView>();
  private _mounted = new Map<string, MountedRecord>();
  private _mcpConfigs = new Map<string, McpServerConfig>();
  private _watchers: fs.FSWatcher[] = [];
  private _watchTimer: NodeJS.Timeout | null = null;
  private _started = false;

  private constructor(options: EcosystemRegistryOptions) {
    super();
    this._options = {
      statePath: writablePath('data', 'ecosystem.json'),
      ...options,
    };
    this._state = this._loadState();
    this._adapters = options.adapters ?? [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new OpenClawAdapter(),
      new OpenCodeAdapter(),
      new HermesAdapter(),
    ];
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    await this.scan();
    const enabledIds = Object.entries(this._state.entries)
      .filter(([, s]) => s.enabled)
      .map(([id]) => id);
    for (const id of enabledIds) {
      try { await this.mount(id); } catch (err) { this._markError(id, (err as Error).message); }
    }
    await this._persistMcp();
    this._saveState();
    if (this._options.watchEnabled ?? this._state.watchEnabled) this._startWatchers();
  }

  async stop(): Promise<void> {
    this._stopWatchers();
    for (const id of [...this._mounted.keys()]) {
      await this.unmount(id).catch(() => {});
    }
    this._started = false;
  }

  // ── Scanning / overview ────────────────────────────────────

  async scan(): Promise<EcosystemEntryView[]> {
    this._assets.clear();
    this._views.clear();
    for (const adapter of this._adapters) {
      const assets = await adapter.scan();
      for (const asset of assets) {
        const id = entryId(asset);
        this._assets.set(id, asset);
        const state = this._state.entries[id];
        this._views.set(id, this._toView(asset, state));
      }
    }
    // Enabled entries whose source vanished get surfaced as errors.
    for (const [id, state] of Object.entries(this._state.entries)) {
      if (state.enabled && !this._assets.has(id)) {
        this._markError(id, 'Source no longer found during scan');
      }
    }
    return [...this._views.values()];
  }

  async overview(): Promise<EcosystemOverview> {
    await this.scan();
    const kinds = ECOSYSTEM_KINDS.map((kind) => {
      const adapter = this._adapters.find((a) => a.kind === kind)!;
      const entries = [...this._views.values()].filter((v) => v.kind === kind);
      return {
        kind,
        label: ECOSYSTEM_LABELS[kind],
        count: entries.length,
        roots: adapter.roots(),
      };
    });
    return {
      kinds,
      entries: [...this._views.values()],
      total: this._views.size,
      watchEnabled: this._state.watchEnabled,
    };
  }

  async sync(): Promise<{ synced: number; mounted: number; failed: string[] }> {
    await this.scan();
    let mounted = 0;
    const failed: string[] = [];
    for (const [id, state] of Object.entries(this._state.entries)) {
      if (!state.enabled) continue;
      try {
        if (!this._mounted.has(id)) {
          await this.mount(id);
          mounted++;
        }
      } catch (err) {
        failed.push(id);
        this._markError(id, (err as Error).message);
      }
    }
    await this._persistMcp();
    this._saveState();
    TypedEventBus.emit('ecosystem:state-change', { action: 'synced', total: this._views.size });
    this.emit('synced', this._views.size);
    return { synced: this._views.size, mounted, failed };
  }

  // ── Entry operations ───────────────────────────────────────

  entries(): EcosystemEntryView[] {
    return [...this._views.values()];
  }

  async enable(id: string): Promise<EcosystemEntryView> {
    const asset = this._assets.get(id);
    if (!asset) throw new Error(`Ecosystem entry not found: ${id}`);
    const state = this._state.entries[id] ?? this._defaultState();
    if (requiresTrustReview(asset.assetType, asset.supportLevel) && !state.trusted) {
      throw new Error(`Entry "${asset.name}" requires a trust review before it can be enabled`);
    }
    state.enabled = true;
    state.status = 'enabled';
    state.errorMessage = undefined;
    this._state.entries[id] = state;
    try {
      await this.mount(id);
      await this._persistMcp();
      this._saveState();
      TypedEventBus.emit('ecosystem:state-change', { action: 'enabled', entryId: id });
      TypedEventBus.emit('ecosystem:entry-updated', { entryId: id, status: 'enabled', enabled: true });
      return this._toView(asset, state);
    } catch (err) {
      state.enabled = false;
      state.status = 'error';
      state.errorMessage = (err as Error).message;
      this._saveState();
      throw err;
    }
  }

  async disable(id: string): Promise<EcosystemEntryView> {
    const asset = this._assets.get(id);
    await this.unmount(id).catch(() => {});
    const state = this._state.entries[id] ?? this._defaultState();
    state.enabled = false;
    state.status = 'disabled';
    state.errorMessage = undefined;
    this._state.entries[id] = state;
    await this._persistMcp();
    this._saveState();
    TypedEventBus.emit('ecosystem:state-change', { action: 'disabled', entryId: id });
    TypedEventBus.emit('ecosystem:entry-updated', { entryId: id, status: 'disabled', enabled: false });
    return asset ? this._toView(asset, state) : this._fallbackView(id, state);
  }

  async trust(id: string): Promise<EcosystemEntryView> {
    const asset = this._assets.get(id);
    const state = this._state.entries[id] ?? this._defaultState();
    state.trusted = true;
    this._state.entries[id] = state;
    this._saveState();
    TypedEventBus.emit('ecosystem:state-change', { action: 'trusted', entryId: id });
    return asset ? this._toView(asset, state) : this._fallbackView(id, state);
  }

  async forget(id: string): Promise<{ forgotten: boolean }> {
    await this.unmount(id).catch(() => {});
    this._state.entries[id] = { ...this._defaultState(), enabled: false, status: 'disabled' };
    delete this._state.entries[id];
    this._assets.delete(id);
    this._views.delete(id);
    await this._persistMcp();
    this._saveState();
    TypedEventBus.emit('ecosystem:state-change', { action: 'forgotten', entryId: id });
    return { forgotten: true };
  }

  // ── Mount / unmount ────────────────────────────────────────

  async mount(id: string): Promise<MountedRecord> {
    const asset = this._assets.get(id);
    if (!asset) throw new Error(`Ecosystem entry not found: ${id}`);
    if (this._mounted.has(id)) return this._mounted.get(id)!;

    const state = this._state.entries[id] ?? this._defaultState();
    let record: MountedRecord;

    switch (asset.assetType) {
      case 'skill': {
        const mountName = this._mountName(asset, state);
        const gates = evaluateSkillGates(asset.kind, parseSkillFrontmatterForGates(asset), {
          tools: new Set(ToolRegistry.getInstance().allTools().map((t) => t.name())),
        });
        if (!gates.ok) {
          throw new Error(`Skill gated out: ${gates.reasons.join('; ')}`);
        }
        const { skill, warnings } = parseSkillAsset(asset, mountName, gates);
        const registered = SkillManager.getInstance().registerSkill(skill, SkillSource.Ecosystem);
        if (!registered) throw new Error(`Native skill "${mountName}" takes priority`);
        record = { entryId: id, assetType: 'skill', names: [skill.name()], mcpConfig: undefined };
        state.warnings = warnings;
        break;
      }
      case 'mcp': {
        const serverName = String(asset.payload.serverName ?? asset.name);
        const raw = asset.payload.server as Record<string, unknown> ?? {};
        const { config, warnings } = normalizeMcpServer(asset.kind, serverName, raw, {
          entryId: id,
          sourcePath: asset.sourcePath,
        });
        this._mcpConfigs.set(id, config);
        record = { entryId: id, assetType: 'mcp', names: [serverName], mcpConfig: config };
        state.warnings = warnings;
        break;
      }
      case 'command': {
        const imported = parseCommandAsset(asset);
        const mountName = this._mountName(asset, state);
        const cmd = new EcosystemMarkdownCommand(imported, mountName);
        CommandRegistry.getInstance().registerCommand(cmd);
        record = { entryId: id, assetType: 'command', names: [mountName] };
        break;
      }
      case 'agent': {
        const imported = parseAgentAsset(asset);
        const role = imported.mode === 'subagent' ? AgentRole.SubAgent : AgentRole.Member;
        const agentId = `ecosystem-${slug(asset.kind)}-${slug(asset.name)}-${djb2(asset.sourcePath).slice(0, 6)}`;
        const config = defaultConfig({
          id: agentId,
          name: imported.name,
          role,
          level: role === AgentRole.SubAgent ? 3 : 2,
          parentAgentId: null,
          teamName: `ecosystem-${asset.kind}`,
          agentPrompt: imported.body,
          allowedTools: imported.allowedTools ?? [],
        });
        AgentRegistry.getInstance().registerAgent(new Agent(config));
        record = { entryId: id, assetType: 'agent', names: [agentId] };
        break;
      }
      case 'plugin': {
        if (asset.kind === 'opencode' && asset.supportLevel === 'bridge') {
          const pluginPath = asset.payload.pluginPath as string;
          const bridge = new OpenCodePluginBridge(pluginPath, (asset.payload.cwd as string) ?? process.cwd());
          const handle = await bridge.start();
          record = {
            entryId: id,
            assetType: 'plugin',
            names: handle.toolNames,
            bridge,
          };
          state.warnings = [
            ...(handle.unmappedHooks.length ? [`Unmapped hooks: ${handle.unmappedHooks.join(', ')}`] : []),
            ...(handle.mappedHooks ? [`${handle.mappedHooks} hook(s) mapped to AnoClaw events`] : []),
          ];
        } else if (asset.kind === 'hermes') {
          throw new Error('Hermes plugins are Python-based and not executable in v1');
        } else {
          // Codex/Claude/OpenClaw plugins are declarative — their skills/MCP/
          // commands/agents/hooks are separate entries and mount independently.
          record = { entryId: id, assetType: 'plugin', names: [] };
          state.warnings = state.warnings ?? [];
        }
        break;
      }
      case 'hook': {
        const hooksFile = asset.payload.hooksFile as string;
        const hooks = loadHooksJson(hooksFile);
        const eventNames = Object.keys(hooks);
        state.warnings = [
          `Detected hook events: ${eventNames.join(', ') || 'none'}`,
          'Hook command execution is not enabled in v1; events are mapped for visibility only',
        ];
        record = { entryId: id, assetType: 'hook', names: [] };
        break;
      }
      case 'rule': {
        record = { entryId: id, assetType: 'rule', names: [] };
        state.warnings = ['Project rule files are listed only and are not auto-injected into prompts'];
        break;
      }
      default:
        throw new Error(`Unsupported asset type: ${asset.assetType}`);
    }

    state.enabled = true;
    state.status = 'enabled';
    state.errorMessage = undefined;
    state.lastSyncedAt = new Date().toISOString();
    this._state.entries[id] = state;
    this._mounted.set(id, record);
    TypedEventBus.emit('ecosystem:entry-updated', { entryId: id, status: 'enabled', enabled: true });
    this.emit('mounted', id, asset.assetType);
    return record;
  }

  async unmount(id: string): Promise<void> {
    const record = this._mounted.get(id);
    if (!record) return;
    this._mounted.delete(id);
    try {
      switch (record.assetType) {
        case 'skill':
          for (const name of record.names) SkillManager.getInstance().unregisterSkill(name);
          break;
        case 'command':
          for (const name of record.names) CommandRegistry.getInstance().unregisterCommand(name);
          break;
        case 'agent':
          for (const agentId of record.names) AgentRegistry.getInstance().unregisterAgent(agentId);
          break;
        case 'mcp':
          this._mcpConfigs.delete(id);
          break;
        case 'plugin':
          if (record.bridge) await record.bridge.dispose();
          break;
        default:
          break;
      }
    } finally {
      TypedEventBus.emit('ecosystem:entry-updated', { entryId: id, status: 'disabled', enabled: false });
      this.emit('unmounted', id);
    }
  }

  // ── MCP persistence ────────────────────────────────────────

  private async _persistMcp(): Promise<void> {
    if (this._options.mcpPersist) {
      await this._options.mcpPersist([...this._mcpConfigs.values()]);
      return;
    }
    const { McpManager } = await import('../../infra/mcp/McpManager.js');
    await McpManager.getInstance().replaceImportedServers([...this._mcpConfigs.values()]);
  }

  // ── State helpers ──────────────────────────────────────────

  private _defaultState(): EcosystemEntryState {
    return { enabled: false, trusted: false, cleanName: false, status: 'discovered' };
  }

  private _loadState(): EcosystemStateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this._options.statePath!, 'utf8')) as EcosystemStateFile;
      if (raw && typeof raw === 'object' && raw.entries) return raw;
    } catch { /* first run */ }
    return { version: STATE_VERSION, updatedAt: new Date().toISOString(), watchEnabled: false, entries: {} };
  }

  private _saveState(): void {
    try {
      this._state.updatedAt = new Date().toISOString();
      const file = this._options.statePath!;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* best-effort persistence */ }
  }

  private _toView(asset: EcosystemAsset, state?: EcosystemEntryState): EcosystemEntryView {
    const s = state ?? this._defaultState();
    return {
      id: entryId(asset),
      kind: asset.kind,
      assetType: asset.assetType,
      name: asset.name,
      displayName: asset.displayName,
      sourcePath: asset.sourcePath,
      supportLevel: asset.supportLevel,
      detail: asset.detail,
      warnings: [...(asset.warnings ?? []), ...(s.warnings ?? [])],
      status: s.status,
      enabled: s.enabled,
      trusted: s.trusted,
      cleanName: s.cleanName,
      lastSyncedAt: s.lastSyncedAt,
      errorMessage: s.errorMessage,
    };
  }

  private _fallbackView(id: string, state: EcosystemEntryState): EcosystemEntryView {
    const parts = id.split(':');
    const kind = parts[0] ?? 'codex';
    const assetType = parts[1] ?? 'skill';
    const name = parts.slice(2).join(':') || id;
    return {
      id,
      kind: (kind ?? 'codex') as EcosystemKind,
      assetType: (assetType ?? 'skill') as EcosystemAssetType,
      name: name ?? id,
      displayName: name ?? id,
      sourcePath: '',
      supportLevel: 'native' as SupportLevel,
      status: state.status,
      enabled: state.enabled,
      trusted: state.trusted,
      cleanName: state.cleanName,
      lastSyncedAt: state.lastSyncedAt,
      errorMessage: state.errorMessage,
    };
  }

  private _markError(id: string, message: string): void {
    const state = this._state.entries[id] ?? this._defaultState();
    state.status = 'error';
    state.errorMessage = message;
    this._state.entries[id] = state;
    TypedEventBus.emit('ecosystem:entry-updated', { entryId: id, status: 'error', enabled: state.enabled });
  }

  private _mountName(asset: EcosystemAsset, state: EcosystemEntryState): string {
    const raw = slug(asset.name);
    if (state.cleanName) {
      const skillManager = SkillManager.getInstance();
      const collides = skillManager.allSkills().some((s) => s.name() === raw)
        || [...this._mounted.values()].some((r) => r.names.includes(raw));
      if (!collides) return raw;
    }
    return `${asset.kind}:${raw}`;
  }

  // ── Watchers (optional hot sync) ───────────────────────────

  private _startWatchers(): void {
    this._stopWatchers();
    const roots = new Set<string>();
    for (const adapter of this._adapters) {
      for (const root of adapter.roots()) {
        if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) roots.add(root);
      }
    }
    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, () => this._scheduleSync());
        this._watchers.push(watcher);
      } catch { /* unsupported recursive watch — manual sync still available */ }
    }
  }

  private _stopWatchers(): void {
    for (const watcher of this._watchers) {
      try { watcher.close(); } catch { /* best-effort */ }
    }
    this._watchers = [];
    if (this._watchTimer) {
      clearTimeout(this._watchTimer);
      this._watchTimer = null;
    }
  }

  private _scheduleSync(): void {
    if (this._watchTimer) clearTimeout(this._watchTimer);
    this._watchTimer = setTimeout(() => {
      this._watchTimer = null;
      void this.sync().catch(() => {});
    }, 1000);
  }
}

/** Cheap frontmatter extraction used for gate evaluation before import. */
function parseSkillFrontmatterForGates(asset: EcosystemAsset): Record<string, unknown> {
  const content = asset.payload.content as string | undefined;
  if (!content) return {};
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value === 'true') fm[key] = true;
    else if (value === 'false') fm[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) fm[key] = Number(value);
    else fm[key] = value.replace(/^["']|["']$/g, '');
  }
  if (typeof fm.metadata === 'string') {
    try {
      const parsed = JSON.parse(fm.metadata as string);
      if (parsed && typeof parsed === 'object') fm.metadata = parsed;
    } catch { /* keep string */ }
  }
  return fm;
}
