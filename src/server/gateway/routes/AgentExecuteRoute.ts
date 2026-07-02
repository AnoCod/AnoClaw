// AgentExecuteRoute — Run a full agent task programmatically.
// Creates/finds a session, runs the full ReAct loop with tools+prompts+memory,
// returns the complete response. Available to all plugins via anoclaw.api.call().
// Real-time streaming events are forwarded to the frontend via WebSocket.
// Supports ephemeral mode: deleteOnComplete=true deletes the session after done.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatch, RouteHandler } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { WsMessageType } from '../../../shared/types/events.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import { DEFAULT_MAIN_AGENT_ID } from '../../../shared/constants.js';
import { WsServer } from '../../infra/network/WsServer.js';

/** Resolve root session ID for WebSocket routing */
function resolveRootSessionId(sessionId: string): string {
  try {
    const sm = SessionManager.getInstance();
    const root = sm.getRootSession(sessionId);
    return root.id;
  } catch {
    return sessionId;
  }
}

export class AgentExecuteRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/agent/execute';
  readonly description = 'Submit a task to an agent. Returns the complete response. Streaming events forwarded via WebSocket. Set deleteOnComplete=true to auto-cleanup the session after execution.';
  readonly category = 'Agent';

  async handle(
    _match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    let sessionCreated = false;
    let sessionId = '';

    try {
      const body = await readBody(req);
      const task = body.task as string | undefined;
      if (!task) {
        sendJson(res, 400, { error: 'Missing "task" field' });
        return true;
      }
      const agentId = (body.agentId as string) || DEFAULT_MAIN_AGENT_ID;
      const deleteOnComplete = body.deleteOnComplete === true;

      const sm = SessionManager.getInstance();
      const requestedId = (body.sessionId as string) || '';
      // Check if a session with this ID already exists
      const existing = requestedId ? sm.session(requestedId) : null;

      if (existing) {
        sessionId = requestedId;
      } else {
        const session = await sm.createMainSession(agentId, `Agent Execute (${agentId})`);
        sessionId = session.id;
        sessionCreated = true;
      }

      const msg: Message = {
        id: `exec-${Date.now()}`,
        sessionId,
        role: MessageRole.System,
        content: task,
        tokenCount: 0,
        compressed: false,
        timestamp: new Date().toISOString(),
      };
      await sm.appendMessage(sessionId, msg);

      const history = await sm.getHistory(sessionId);
      const runtime = AgentRuntime.getInstance();
      const ws = WsServer.getInstance();
      const rootId = resolveRootSessionId(sessionId);

      let fullContent = '';
      for await (const event of runtime.processMessage(sessionId, agentId, msg, history)) {
        if (ws.isConnected(rootId)) {
          ws.send(rootId, event as Record<string, unknown>);
        }
        if (event.type === WsMessageType.Text) {
          fullContent += (event.content as string) || '';
        }
      }

      // Ephemeral: delete session if we created it
      if (deleteOnComplete && sessionCreated) {
        try { await sm.archiveSession(sessionId); } catch {}
      }

      sendJson(res, 200, { content: fullContent, sessionId, agentId, ephemeral: deleteOnComplete && sessionCreated });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // On error, still clean up ephemeral session
      if (sessionCreated && sessionId) {
        try { await SessionManager.getInstance().archiveSession(sessionId); } catch {}
      }
      sendJson(res, 500, { error: 'Agent execute failed', message: msg });
      return true;
    }
  }
}
