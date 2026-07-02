// PromptRoutes — prompt preview, custom CLI, cache diagnostics
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { PromptAssembler } from '../../core/prompt/PromptAssembler.js';

export class PreviewAgentPromptRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/agents/:id/prompt';
  category = 'Agents'; description = 'Preview the effective system prompt for an agent (?sessionId=...)';
  handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse): boolean {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const sessionId = url.searchParams.get('sessionId') || 'preview';
      const pa = PromptAssembler.getInstance();
      const prompt = pa.buildEffectivePrompt(m.params['id'], sessionId);
      sendJson(res, 200, { agentId: m.params['id'], sessionId, length: prompt.length, prompt });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class PromptCacheStatsRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/prompt/cache-stats';
  category = 'System'; description = 'Get prompt cache statistics';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const stats = PromptAssembler.getInstance().cacheStats;
      sendJson(res, 200, stats);
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ClearPromptCacheRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/prompt/clear-cache';
  category = 'System'; description = 'Clear all prompt caches (forces full rebuild next turn)';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      PromptAssembler.getInstance().clearAllCaches();
      sendJson(res, 200, { cleared: true });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class GetCustomCLIRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/prompt/custom-cli';
  category = 'System'; description = 'Get runtime-injected CustomCLI instructions';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const cli = PromptAssembler.getInstance().customCLI;
      sendJson(res, 200, { customCLI: cli });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SetCustomCLIRoute implements RouteHandler {
  method = 'PUT' as const; path = '/api/v1/prompt/custom-cli';
  category = 'System'; description = 'Set runtime-injected CustomCLI instructions (body: { instructions })';
  async handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const body = await readBody(req);
      const instructions = (body.instructions as string) || null;
      PromptAssembler.getInstance().setCustomCLI(instructions);
      sendJson(res, 200, { customCLI: instructions });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class PromptSectionsRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/prompt/sections';
  category = 'System'; description = 'List registered prompt section names';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const names = PromptAssembler.getInstance().sectionNames;
      sendJson(res, 200, { sections: names, total: names.length });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
