// AgentExecuteRoute — Run a full agent task programmatically.
// Creates/finds a session, runs the full ReAct loop with tools+prompts+memory,
// returns the complete response. Available to all plugins via anoclaw.api.call().
// Real-time streaming events are forwarded to the frontend via WebSocket.
// Supports ephemeral mode: deleteOnComplete=true deletes the session after done.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteMatch, RouteHandler } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody, sendRedirect } from '../RouteHelpers.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { WsMessageType } from '../../../shared/types/events.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import { WsServer } from '../../infra/network/WsServer.js';
import { selectRunnableAgent } from '../../core/agent/AgentSelection.js';
import { resolveSessionEffort, resolveSessionPermissionMode } from '../../core/agent/PermissionModePolicy.js';
import { SessionTurnRecorder } from '../../infra/SessionTurnRecorder.js';

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
  readonly path = '/api/v1/agents/execute';
  readonly description = 'Submit a task to an agent. Returns the complete response. Streaming events forwarded via WebSocket. Set deleteOnComplete=true to auto-cleanup the session after execution.';
  readonly category = 'Agent';
  readonly permission = 'messages:send';

  async handle(
    _match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    let sessionCreated = false;
    let sessionId = '';
    let recorder: SessionTurnRecorder | null = null;

    try {
      // 1. Parse request body
      const body = await readBody(req);
      const task = body.task as string | undefined;
      if (!task) {
        sendJson(res, 400, { error: 'Missing "task" field' });
        return true;
      }
      const agentSelection = selectRunnableAgent(body.agentId as string | undefined);
      if (!agentSelection.ok || !agentSelection.agentId) {
        sendJson(res, 409, { error: 'Agent Required', message: agentSelection.message || 'No runnable agent is configured' });
        return true;
      }
      const agentId = agentSelection.agentId;
      const deleteOnComplete = body.deleteOnComplete === true;

      // 2. Find or create a session
      const sm = SessionManager.getInstance();
      const requestedId = (body.sessionId as string) || '';
      const existing = requestedId ? sm.session(requestedId) : null;

      if (existing) {
        sessionId = requestedId;
      } else {
        const session = await sm.createMainSession(agentId, `Agent Execute (${agentId})`);
        sessionId = session.id;
        sessionCreated = true;
      }

      // 3. Append the task as a system message
      const msg: Message = {
        id: `exec-${Date.now()}`,
        sessionId,
        role: MessageRole.System,
        content: task,
        tokenCount: 0,
        compressed: false,
        timestamp: new Date().toISOString(),
      };
      const history = await sm.getHistory(sessionId);
      await sm.appendMessage(sessionId, msg);

      // 4. Run the full ReAct loop, streaming to WebSocket
      const runtime = AgentRuntime.getInstance();
      const ws = WsServer.getInstance();
      const rootId = resolveRootSessionId(sessionId);

      let fullContent = '';
      recorder = new SessionTurnRecorder(sessionId, agentId);
      const loopOptions = {
        permissionMode: resolveSessionPermissionMode(sm, sessionId, body.mode),
        effort: resolveSessionEffort(sm, sessionId, body.effort),
      };
      for await (const event of runtime.processMessage(sessionId, agentId, msg, history, loopOptions)) {
        await recorder.record(event);
        if (ws.isConnected(rootId)) {
          ws.send(rootId, event as Record<string, unknown>);
        }
        if (event.type === WsMessageType.Text) {
          fullContent += (event.content as string) || '';
        }
      }
      await recorder.finalize();
      const completedSession = sm.session(sessionId);
      if (completedSession) completedSession.lastEventUuid = recorder.headEventUuid;

      // 5. Ephemeral cleanup: delete session if we created it and caller requested it
      if (deleteOnComplete && sessionCreated) {
        try { await sm.archiveSession(sessionId); } catch {}
      }

      sendJson(res, 200, { content: fullContent, sessionId, agentId, ephemeral: deleteOnComplete && sessionCreated });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recorder?.recordError(msg, 'agent_execute').catch(() => {});
      await recorder?.finalize().catch(() => {});
      // 6. On error, still clean up ephemeral session to avoid leaking
      if (sessionCreated && sessionId) {
        try { await SessionManager.getInstance().archiveSession(sessionId); } catch {}
      }
      sendJson(res, 500, { error: 'Agent execute failed', message: msg });
      return true;
    }
  }
}

/** Redirect old singular path to new plural path */
export class AgentExecuteRedirectRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/agent/execute';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    sendRedirect(res, '/api/v1/agents/execute');
    return true;
  }
}
