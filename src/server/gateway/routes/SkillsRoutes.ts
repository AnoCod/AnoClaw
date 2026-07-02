// SkillsRoutes — skill listing, detail, reload, and auto-generation
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SkillManager } from '../../core/skills/SkillManager.js';

export class ListSkillsRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/skills';
  category = 'Skills'; description = 'List all loaded skills with source info';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const sm = SkillManager.getInstance();
      const sources = sm.skillSources();
      const skills = sm.allSkills().map(s => ({
        id: s.name(),
        name: s.name(),
        description: s.description(),
        content: s.body(),
        source: sources.get(s.name()) ?? 'unknown',
        triggers: s.triggers(),
        enabled: sm.isEnabled(s.name()),
      }));
      sendJson(res, 200, { skills, total: skills.length });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class GetSkillRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/skills/:name';
  category = 'Skills'; description = 'Get a single skill with full body';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const sm = SkillManager.getInstance();
      const s = sm.getSkill(m.params['name']);
      if (!s) { sendJson(res, 404, { error: 'Skill not found' }); return true; }
      sendJson(res, 200, {
        name: s.name(), description: s.description(), body: s.body(),
        triggers: s.triggers(), source: sm.skillSources().get(s.name()) ?? 'unknown',
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ReloadSkillsRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/skills/reload';
  category = 'Skills'; description = 'Reload all skills from disk';
  async handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const sm = SkillManager.getInstance();
      await sm.reloadAll();
      sendJson(res, 200, { reloaded: true, count: sm.count });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class AutoGenerateSkillRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/skills/auto-generate';
  category = 'Skills'; description = 'Auto-generate a SKILL.md from transcript/tool-calls (LLM when config provided)';
  async handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const transcript = body.transcript as unknown[] || [];
      const toolCalls = body.toolCalls as Array<{ name: string; result?: string }> | undefined;
      const llmOptions = body.llm as { model?: string; apiUrl?: string; apiKey?: string } | undefined;
      const sm = SkillManager.getInstance();
      const name = await sm.autoGenerateSkill(
        transcript,
        toolCalls,
        llmOptions?.model && llmOptions?.apiUrl && llmOptions?.apiKey
          ? { model: llmOptions.model, apiUrl: llmOptions.apiUrl, apiKey: llmOptions.apiKey }
          : undefined,
      );
      sendJson(res, 200, { generated: !!name, name });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SkillsForAgentRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/skills/for-agent/:agentId';
  category = 'Skills'; description = 'List skills available to a specific agent';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const sm = SkillManager.getInstance();
      const skills = sm.skillsForAgent(m.params['agentId']);
      sendJson(res, 200, {
        skills: skills.map(s => ({ name: s.name(), description: s.description() })),
        total: skills.length,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

// ─── CRUD Routes ─────────────────────────────────────────────────

export class CreateSkillRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/skills';
  category = 'Skills'; description = 'Create a new skill from name/description/content';
  async handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const name = (body.name as string || '').trim();
      if (!name) { sendJson(res, 400, { error: 'Missing required field: name' }); return true; }
      const description = (body.description as string || '').trim();
      const content = (body.content as string || '').trim();

      const sm = SkillManager.getInstance();
      await sm.createSkill(name, description, content);

      sendJson(res, 201, { id: name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase(), name, status: 'created' });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class PatchSkillRoute implements RouteHandler {
  method = 'PATCH' as const; path = '/api/v1/skills/:name';
  category = 'Skills'; description = 'Update a skill or toggle enabled state';
  async handle(m: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const name = m.params['name'];
      const body = await readBody(req);
      const sm = SkillManager.getInstance();

      // Check skill exists
      const skill = sm.getSkill(name);
      if (!skill) { sendJson(res, 404, { error: 'Skill not found', name }); return true; }

      // Toggle enabled state
      if (body.enabled !== undefined) {
        await sm.toggleSkill(name, body.enabled as boolean);
        sendJson(res, 200, { name, enabled: body.enabled, status: 'toggled' });
        return true;
      }

      // Update description/content
      const description = (body.description as string || '').trim() || skill.description();
      const content = (body.content as string || '').trim() || skill.body();
      await sm.updateSkill(name, description, content);

      sendJson(res, 200, { name, status: 'updated' });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class DeleteSkillRoute implements RouteHandler {
  method = 'DELETE' as const; path = '/api/v1/skills/:name';
  category = 'Skills'; description = 'Delete a skill by name';
  async handle(m: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const name = m.params['name'];
      const sm = SkillManager.getInstance();

      if (!sm.getSkill(name)) {
        sendJson(res, 404, { error: 'Skill not found', name });
        return true;
      }

      await sm.deleteSkill(name);
      sendJson(res, 200, { name, status: 'deleted' });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
