// SkillExecuteRoute — Load and optionally execute a skill.
// POST /api/v1/skills/execute
// Body: { skillName, task?, agentId?, triggerAgent? }
//
// When triggerAgent=false (default): returns the skill body content.
// When triggerAgent=true: loads skill body, combines with task, sends to agent.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatch, RouteHandler } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody, sendRedirect } from '../RouteHelpers.js';
import { SkillManager } from '../../core/skills/SkillManager.js';
import { ApiServer } from '../ApiServer.js';
import { selectRunnableAgent } from '../../core/agent/AgentSelection.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('anochat.route.skill-exec');

export class SkillExecuteRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/skills/execute';
  readonly description = 'Load a skill by name and optionally execute it through an agent with a task.';
  readonly category = 'Skill';
  readonly permission = 'messages:send';

  async handle(
    _match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    try {
      const body = await readBody(req);
      const skillName = body.skillName as string | undefined;
      if (!skillName) { sendJson(res, 400, { error: 'Missing "skillName" field' }); return true; }

      const sm = SkillManager.getInstance();
      const skillBody = sm.loadSkillBody(skillName);
      if (!skillBody) { sendJson(res, 404, { error: `Skill "${skillName}" not found` }); return true; }

      const task = (body.task as string) || '';
      const triggerAgent = body.triggerAgent === true;

      if (!triggerAgent) {
        sendJson(res, 200, { skillName, body: skillBody, length: skillBody.length });
        return true;
      }

      // Run through a real registered agent via ApiServer internal routing.
      const agentSelection = selectRunnableAgent(body.agentId as string | undefined);
      if (!agentSelection.ok || !agentSelection.agentId) {
        sendJson(res, 409, {
          error: 'Agent Required',
          message: agentSelection.message || 'No runnable agent is configured',
        });
        return true;
      }
      const agentId = agentSelection.agentId;
      const fullPrompt = task
        ? `Execute skill "${skillName}":\n\n${skillBody}\n\n---\n\n${task}`
        : `Execute skill "${skillName}". Follow these instructions:\n\n${skillBody}`;

      const api = ApiServer.getInstance();
      const result = await api.callInternal('POST', '/api/v1/agents/execute', {
        agentId, task: fullPrompt,
      });

      sendJson(res, 200, {
        skillName,
        content: (result.body as Record<string, unknown>)?.content || '',
        sessionId: (result.body as Record<string, unknown>)?.sessionId || null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Skill execute failed', { error: msg });
      sendJson(res, 500, { error: 'Skill execute failed', message: msg });
      return true;
    }
  }
}

/** Redirect old singular path to new plural path */
export class SkillExecuteRedirectRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/skill/execute';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    sendRedirect(res, '/api/v1/skills/execute');
    return true;
  }
}
