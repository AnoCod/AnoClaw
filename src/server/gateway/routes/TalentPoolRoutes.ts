// TalentPoolRoutes — REST API for agent template library (talent pool)
// Groups: list, create, update, delete
// Templates: list, get, create, delete, hire

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { TalentPoolService } from '../../core/talent-pool/TalentPoolService.js';

// ═══ Utility helpers ═══════════════════════════════════════
function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

const SVC = () => TalentPoolService.getInstance();

// ═══ Groups ════════════════════════════════════════════════

export class ListGroupsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/talent-pool/groups';
  description = 'List talent pool groups';
  category = 'Talent Pool';
  async handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const groups = SVC().listGroups();
    sendJson(res, 200, { groups });
    return true;
  }
}

export class CreateGroupRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/talent-pool/groups';
  description = 'Create a new talent pool group';
  category = 'Talent Pool';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    const name = (body.name as string || '').trim();
    if (!name) { sendJson(res, 400, { error: 'Group name is required' }); return true; }
    const icon = (body.icon as string) || '📋';
    const description = (body.description as string) || '';
    const group = await SVC().createGroup(name, icon, description);
    sendJson(res, 201, group);
    return true;
  }
}

export class UpdateGroupRoute implements RouteHandler {
  method = 'PATCH' as const;
  path = '/api/v1/talent-pool/groups/:id';
  description = 'Update a talent pool group';
  category = 'Talent Pool';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const id = match.params.id;
    const body = await readBody(req);
    const updated = await SVC().updateGroup(id, body);
    if (!updated) { sendJson(res, 404, { error: 'Group not found' }); return true; }
    sendJson(res, 200, updated);
    return true;
  }
}

export class DeleteGroupRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/talent-pool/groups/:id';
  description = 'Delete a talent pool group';
  category = 'Talent Pool';
  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const ok = await SVC().deleteGroup(match.params.id);
    if (!ok) { sendJson(res, 404, { error: 'Group not found' }); return true; }
    sendJson(res, 200, { status: 'deleted' });
    return true;
  }
}

// ═══ Templates ═════════════════════════════════════════════

export class ListTemplatesRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/talent-pool/templates';
  description = 'List talent pool templates, optionally filtered by groupId';
  category = 'Talent Pool';
  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const groupId = match.query.get('groupId') || undefined;
    const templates = SVC().listTemplates(groupId);
    sendJson(res, 200, { templates, total: templates.length });
    return true;
  }
}

export class GetTemplateRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/talent-pool/templates/:id';
  description = 'Get a talent pool template by id';
  category = 'Talent Pool';
  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const tpl = SVC().getTemplate(match.params.id);
    if (!tpl) { sendJson(res, 404, { error: 'Template not found' }); return true; }
    sendJson(res, 200, tpl);
    return true;
  }
}

export class CreateTemplateRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/talent-pool/templates';
  description = 'Create a new talent pool template (from scratch or save agent)';
  category = 'Talent Pool';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);

    // If this is a "save agent to pool" request
    if (body.agentId) {
      const tpl = await SVC().saveAgentToPool(body as any);
      if (!tpl) { sendJson(res, 400, { error: 'Agent not found or group not found' }); return true; }
      sendJson(res, 201, tpl);
      return true;
    }

    // Create template from scratch
    const name = (body.name as string || '').trim();
    const groupId = (body.groupId as string || '').trim();
    if (!name || !groupId) { sendJson(res, 400, { error: 'name and groupId are required' }); return true; }

    const tpl = await SVC().createTemplate(body as any);
    sendJson(res, 201, tpl);
    return true;
  }
}

export class DeleteTemplateRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/talent-pool/templates/:id';
  description = 'Delete a talent pool template';
  category = 'Talent Pool';
  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const ok = await SVC().deleteTemplate(match.params.id);
    if (!ok) { sendJson(res, 404, { error: 'Template not found' }); return true; }
    sendJson(res, 200, { status: 'deleted' });
    return true;
  }
}

export class HireTemplateRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/talent-pool/templates/:id/hire';
  description = 'Hire a template — create an agent from it with hierarchy validation';
  category = 'Talent Pool';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    const result = await SVC().hireTemplate({
      templateId: match.params.id,
      parentAgentId: body.parentAgentId as string,
      role: body.role as any,
      name: body.name as string | undefined,
    });
    if (!result.success) {
      // 400 for validation errors, 404 for missing template
      if (result.error?.includes('not found')) {
        sendJson(res, 404, { error: result.error });
      } else {
        sendJson(res, 400, { error: result.error });
      }
      return true;
    }
    sendJson(res, 201, { status: 'hired', agentId: result.agentId });
    return true;
  }
}
