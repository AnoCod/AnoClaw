// RpcDispatcher.ts — Dispatches RPC calls from plugin Workers to kernel services.
// Extracted from PluginHostManager._dispatchWorkerRPC to keep the switch manageable.

import * as path from 'path';
import * as fs from 'fs';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { PromptAssembler } from '../prompt/PromptAssembler.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { MemoryScope, MemoryType } from '../memory/MemoryEntry.js';
import { ApiServer } from '../../gateway/ApiServer.js';
import { createLogger } from '../logger.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import { APIScheduler } from '../../infra/llm/APIScheduler.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { extensionPoints } from './ExtensionPoints.js';
import { PluginToolProxy } from './PluginToolProxy.js';
import type { PluginHostManager } from './PluginHostManager.js';
import type { PluginLLMMessage, PluginLLMOptions, PluginMemorySearchOptions } from './PluginRPC.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import type { LLMOptions } from '../../../shared/types/llm.js';

const log = createLogger('anochat.plugins');
const MAX_RESULT_CHARS = 50_000;

function truncateResult(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;
  return content.slice(0, MAX_RESULT_CHARS) + '\n\n[... result truncated]';
}

function assertPathWithinWorkspace(filePath: string): void {
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(process.cwd())) {
    throw new Error(`Path outside workspace: ${filePath}`);
  }
}

/**
 * RPC dispatcher for plugin Worker calls.
 * Each method corresponds to a case in the original switch statement.
 */
export class RpcDispatcher {
  constructor(
    private _installedTools: Map<string, string>,
    private _eventSubs: Map<string, Set<string>>,
    private _hostManager: PluginHostManager,
  ) {}

  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'tools.register': {
        const p = params as {
          pluginName: string;
          toolDef: { name: string; description: string; parametersSchema: Record<string, unknown>; category: string };
        };
        return this._registerPluginTool(p.pluginName, p.toolDef);
      }

      case 'api.call': {
        const p = params as { method: string; path: string; body?: Record<string, unknown> };
        const api = ApiServer.getInstance();
        const result = await api.callInternal(p.method, p.path, p.body);
        return result;
      }

      case 'tools.deregister': {
        const p = params as { pluginName: string };
        this._deregisterPluginTools(p.pluginName);
        for (const [, plugins] of this._eventSubs) {
          plugins.delete(p.pluginName);
          if (plugins.size === 0) this._eventSubs.delete(p.pluginName);
        }
        return { deregistered: true };
      }

      case 'routes.register': {
        const p = params as { pluginName: string; routes: Array<{ method: string; path: string; handler: string }> };
        ApiServer.getInstance().registerPluginRoutes(p.pluginName, p.routes);
        return { registered: p.routes.length };
      }

      case 'log': {
        const p = params as { pluginName: string; level: string; message: string };
        switch (p.level) {
          case 'error': log.error(`[${p.pluginName}] ${p.message}`); break;
          case 'warn': log.warn(`[${p.pluginName}] ${p.message}`); break;
          default: log.info(`[${p.pluginName}] ${p.message}`); break;
        }
        return null;
      }

      // ── Deprecated service stubs ──
      case 'mcp.listServers':
      case 'mcp.getServer':
      case 'meeting.create':
      case 'gateway.send':
      case 'gateway.status':
      case 'workflow.list':
      case 'workflow.get':
      case 'workflow.save':
      case 'workflow.delete':
        throw new Error(`Service '${method}' has moved to plugin — use anoclaw.api.call() instead`);

      // ── Extended Plugin API ──

      case 'tools.execute': {
        const p = params as { pluginName: string; toolName: string; toolParams: Record<string, unknown>; userConfirmed?: boolean; mode?: string };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`,
          agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(),
          userConfirmed: p.userConfirmed === true,
          ...(p.mode ? { mode: normalizeToolExecutionMode(p.mode) } : {}),
        };
        const result = await ToolRegistry.getInstance().execute(p.toolName, p.toolParams, ctx);
        return { content: truncateResult(result.content), success: result.success, errorMessage: result.errorMessage };
      }

      case 'llm.chat': {
        const p = params as { pluginName: string; messages: PluginLLMMessage[]; options: PluginLLMOptions };
        const settings = SettingsManager.getInstance();
        const model = p.options.model || settings.get<string>('model', 'deepseek-chat');
        const apiUrl = settings.get<string>('apiUrl', 'https://api.deepseek.com');
        const apiKey = settings.get<string>('apiKey', '');
        const provider = settings.get<string>('provider', 'openai-compatible');
        const temperature = p.options.temperature ?? settings.get<number>('llm.temperature', 0.7);
        const maxTokens = p.options.maxTokens || settings.get<number>('llm.maxTokens', 4096);

        const llmOptions: LLMOptions = {
          model, maxTokens, temperature, contextWindow: 128000, apiUrl, apiKey,
        };

        const llmProvider = createLLMProvider(provider, extensionPoints);
        const rawMsgs = p.messages as Array<{ role: string; content: string }>;
        const systemMsgs = rawMsgs.filter(m => m.role === 'system').map(m => m.content);
        const systemPrompt = systemMsgs.join('\n\n');
        const msgs = rawMsgs.filter(m => m.role !== 'system');

        await APIScheduler.getInstance().acquireSlot(apiKey, maxTokens);
        const stream = llmProvider.chat(msgs, [], systemPrompt, llmOptions);
        let content = '';
        for await (const event of stream) {
          switch (event.type) {
            case 'text_delta': content += event.content || ''; break;
            case 'done': break;
            case 'error': log.warn('Plugin LLM stream error', { pluginName: p.pluginName, error: event.errorMessage }); break;
          }
        }
        return { content: truncateResult(content), finishReason: 'stop', usage: { inputTokens: Math.ceil(JSON.stringify(msgs).length / 4), outputTokens: Math.ceil(content.length / 4) } };
      }

      case 'fs.read': {
        const p = params as { pluginName: string; path: string };
        const resolvedPath = path.resolve(p.path);
        assertPathWithinWorkspace(resolvedPath);
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return { content };
      }

      case 'fs.write': {
        const p = params as { pluginName: string; path: string; content: string };
        const resolvedPath = path.resolve(p.path);
        assertPathWithinWorkspace(resolvedPath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, p.content, 'utf-8');
        return { written: true };
      }

      case 'fs.grep': {
        const p = params as { pluginName: string; pattern: string; glob: string };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`, agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(), userConfirmed: true,
        };
        const result = await ToolRegistry.getInstance().execute('Grep', { pattern: p.pattern, path: p.glob || '.' }, ctx);
        const lines = (result.content || '').split('\n').filter(Boolean);
        const matches = lines.map(line => {
          const idx = line.indexOf(':');
          const idx2 = line.indexOf(':', idx + 1);
          if (idx < 0 || idx2 < 0) return { file: line, line: 0, content: '' };
          return { file: line.slice(0, idx), line: parseInt(line.slice(idx + 1, idx2), 10) || 0, content: line.slice(idx2 + 1) };
        });
        return { matches };
      }

      case 'fs.glob': {
        const p = params as { pluginName: string; pattern: string };
        const ctx: ExecutionContext = {
          sessionId: `plugin:${p.pluginName}`, agentId: `plugin:${p.pluginName}`,
          workspace: process.cwd(), userConfirmed: true,
        };
        const result = await ToolRegistry.getInstance().execute('Glob', { pattern: p.pattern, path: '.' }, ctx);
        const files = (result.content || '').split('\n').filter(Boolean);
        return { files };
      }

      case 'memory.search': {
        const p = params as { pluginName: string; query: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const entries = await mm.search(agentId, scope, p.query, p.options.sessionId, p.options.subScope, p.options.fuzzy ?? true);
        const limited = p.options.limit ? entries.slice(0, p.options.limit) : entries;
        return { entries: limited.map(e => ({ ...e })) };
      }

      case 'memory.save': {
        const p = params as { pluginName: string; entry: { name: string; type: string; description: string; content: string; scope: string; sessionId?: string; subScope?: 'team' | 'personal' } };
        const mm = MemoryManager.getInstance();
        const saved = await mm.saveFromParams(p.pluginName, {
          scope: p.entry.scope, type: p.entry.type, name: p.entry.name,
          description: p.entry.description, content: p.entry.content,
        });
        return { entry: { ...saved } };
      }

      case 'memory.list': {
        const p = params as { pluginName: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const entries = await mm.search(agentId, scope, '', p.options.sessionId, p.options.subScope, false);
        const limited = p.options.limit ? entries.slice(0, p.options.limit) : entries;
        return { entries: limited.map(e => ({ ...e })) };
      }

      case 'memory.delete': {
        const p = params as { pluginName: string; name: string; options: PluginMemorySearchOptions };
        const mm = MemoryManager.getInstance();
        const agentId = p.options.agentId || p.pluginName;
        const scope = (p.options.scope as MemoryScope) || MemoryScope.Team;
        const removed = await mm.remove(agentId, scope, p.name, p.options.sessionId, p.options.subScope);
        return { deleted: removed };
      }

      case 'events.subscribe': {
        const p = params as { pluginName: string; event: string };
        if (!this._eventSubs.has(p.event)) this._eventSubs.set(p.event, new Set());
        this._eventSubs.get(p.event)!.add(p.pluginName);
        log.info('Plugin subscribed to event', { pluginName: p.pluginName, event: p.event });
        return { subscribed: true };
      }

      case 'events.unsubscribe': {
        const p = params as { pluginName: string; event: string };
        const subs = this._eventSubs.get(p.event);
        if (subs) {
          subs.delete(p.pluginName);
          if (subs.size === 0) this._eventSubs.delete(p.event);
        }
        log.info('Plugin unsubscribed from event', { pluginName: p.pluginName, event: p.event });
        return { unsubscribed: true };
      }

      case 'ws.broadcast': {
        const p = params as { pluginName: string; message: Record<string, unknown> };
        WsServer.getInstance().broadcast(p.message);
        return { broadcast: true };
      }

      case 'prompt.inject': {
        const p = params as { pluginName: string; name: string; content: string; priority: number };
        const pa = PromptAssembler.getInstance();
        const sectionName = `plugin:${p.pluginName}:${p.name}`;
        pa.registerSection({ name: sectionName, cacheBreak: false, compute: () => p.content }, 'dynamic');
        log.info('Plugin prompt injected', { pluginName: p.pluginName, name: p.name });
        return { injected: true };
      }

      case 'ui.mount': {
        const p = params as { pluginName: string; slot: string; htmlContent: string; opts: { position?: string; replace?: boolean; id?: string; priority?: number } };
        WsServer.getInstance().broadcast({
          type: 'plugin:ui:mount', slot: p.slot, htmlContent: p.htmlContent,
          opts: p.opts || {}, pluginName: p.pluginName,
        });
        return { ok: true };
      }

      case 'ui.unmountAll': {
        const p = params as { pluginName: string; slot: string };
        WsServer.getInstance().broadcast({
          type: 'plugin:ui:unmountAll', slot: p.slot, pluginName: p.pluginName,
        });
        return { ok: true };
      }

      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  // ── Tool management ──

  private _registerPluginTool(
    pluginName: string,
    toolDef: { name: string; description: string; parametersSchema: Record<string, unknown>; category: string },
  ): { registered: boolean } {
    // Deregister old tool with same name first (handles reload case)
    if (this._installedTools.has(toolDef.name)) {
      ToolRegistry.getInstance().deregisterTool(toolDef.name);
    }
    const proxy = new PluginToolProxy(pluginName, toolDef, this._hostManager);
    ToolRegistry.getInstance().registerTool(proxy, toolDef.category || 'Plugin', { source: 'plugin', pluginName });
    this._installedTools.set(toolDef.name, pluginName);
    log.info('Plugin tool registered', { pluginName, toolName: toolDef.name });
    return { registered: true };
  }

  private _deregisterPluginTools(pluginName: string): void {
    const toRemove: string[] = [];
    for (const [toolName, pn] of this._installedTools) {
      if (pn === pluginName) toRemove.push(toolName);
    }
    for (const toolName of toRemove) {
      ToolRegistry.getInstance().deregisterTool(toolName);
      this._installedTools.delete(toolName);
    }
  }
}

function normalizeToolExecutionMode(value: unknown): string {
  if (typeof value !== 'string') return 'auto';
  switch (value) {
    case 'Ask':
    case 'ask':
      return 'ask';
    case 'AutoEdit':
    case 'auto-edit':
    case 'auto_edit':
      return 'auto_edit';
    case 'Plan':
    case 'plan':
    case 'read_only':
    case 'readOnly':
      return 'read_only';
    case 'Auto':
    case 'auto':
      return 'auto';
    default:
      return value;
  }
}
