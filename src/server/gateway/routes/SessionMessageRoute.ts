// SessionMessageRoute — Inject a message into a session, optionally triggering the agent.
// POST /api/v1/session/:id/messages
// Body: { content, role?: 'user'|'system', triggerAgent?: boolean }
//
// When triggerAgent=true:
//   - If session has an active loop → queues via InterruptController (agent responds mid-turn)
//   - If session idle → spawns a background agent loop, forwards streaming via WebSocket
// Returns 202 with the message ID. The frontend receives real-time streaming events
// through its WebSocket connection.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatch, RouteHandler } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import { WsMessageType } from '../../../shared/types/events.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { InterruptController, InterruptReason } from '../../core/agent/supervision/InterruptController.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('anochat.route.session-msg');

function resolveRootSessionId(sessionId: string): string {
  try { return SessionManager.getInstance().getRootSession(sessionId).id; }
  catch { return sessionId; }
}

export class SessionMessageRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/session/:id/messages';
  readonly description = 'Inject a message into a session. Set triggerAgent=true to have the agent process it.';
  readonly category = 'Session';

  async handle(
    match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    try {
      const sessionId = match.params.id;
      const body = await readBody(req);
      const content = body.content as string | undefined;
      if (!content) { sendJson(res, 400, { error: 'Missing "content" field' }); return true; }

      const role = (body.role as string) === 'system' ? MessageRole.System : MessageRole.User;
      const triggerAgent = body.triggerAgent === true;

      const sm = SessionManager.getInstance();
      const session = sm.session(sessionId);
      if (!session) { sendJson(res, 404, { error: `Session "${sessionId}" not found` }); return true; }

      const msg: Message = {
        id: `inj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        role,
        content,
        tokenCount: 0,
        compressed: false,
        timestamp: new Date().toISOString(),
      };
      await sm.appendMessage(sessionId, msg);

      // Notify frontend via WS
      const ws = WsServer.getInstance();
      const rootId = resolveRootSessionId(sessionId);
      if (ws.isConnected(rootId)) {
        ws.send(rootId, { type: 'message_appended', sessionId, messageId: msg.id, role });
      }

      if (!triggerAgent) {
        sendJson(res, 200, { messageId: msg.id, sessionId, triggered: false });
        return true;
      }

      const agentId = session.agentId || AgentRegistry.getInstance().mainAgent()?.id || 'main-agent';
      const runtime = AgentRuntime.getInstance();

      if (runtime.isSessionActive(sessionId)) {
        // Active loop — queue via InterruptController
        InterruptController.getInstance().setPendingUserMessage(sessionId, content);
        InterruptController.getInstance().requestInterrupt(sessionId, InterruptReason.UserSteer);
        if (ws.isConnected(rootId)) {
          ws.send(rootId, { type: WsMessageType.StatusInfo, content: '(Message queued — agent will respond shortly)' });
        }
        sendJson(res, 202, { messageId: msg.id, sessionId, triggered: true, queued: true });
        return true;
      }

      // Idle session — spawn background agent loop, forward events to WS
      const history = await sm.getHistory(sessionId);
      (async () => {
        try {
          for await (const event of runtime.processMessage(sessionId, agentId, msg, history)) {
            if (ws.isConnected(rootId)) {
              ws.send(rootId, event as Record<string, unknown>);
            }
          }
          sm.rebuildMessageCache(sessionId).catch(() => {});
        } catch (err) {
          log.error('Background agent loop failed', { sessionId, error: (err as Error).message });
          if (ws.isConnected(rootId)) {
            ws.send(rootId, { type: WsMessageType.Error, errorMessage: `Agent error: ${(err as Error).message}`, code: 'BACKGROUND_AGENT_ERROR' });
          }
        }
      })();

      sendJson(res, 202, { messageId: msg.id, sessionId, triggered: true, queued: false });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'Session message failed', message: msg });
      return true;
    }
  }
}
