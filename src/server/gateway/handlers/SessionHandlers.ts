// SessionHandlers — session CRUD HTTP handlers extracted from ApiServer
// Handles: list, create, get, archive, rename, auto-title, messages, send, clear-all, overview
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as http from 'http';
import { SessionManager } from '../../core/session/index.js';
import { SessionStore } from '../../core/session/SessionStore.js';
import { JsonlStore } from '../../infra/storage/JsonlStore.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { WsServer } from '../../infra/network/WsServer.js';
import {
  hasSendableUserPayload,
  sendMessageHandler,
  type IncomingAttachment,
} from '../../infra/network/handlers/SendMessageHandler.js';
import { TypedEventBus } from '../../core/events/TypedEventBus.js';
import { requireWs, requireWsAny } from '../WsRequired.js';
import { LogManager } from '../../infra/logging/LogManager.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import type { Message, TokenBreakdown } from '../../../shared/types/session.js';
import { MessageRole, SessionStatus } from '../../../shared/types/session.js';
import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType } from '../../../shared/types/events.js';
import type { LLMOptions } from '../../../shared/types/llm.js';
import { ToolProfiler } from '../../infra/supervision/ToolProfiler.js';
import { MemoryManager } from '../../core/memory/MemoryManager.js';
import { MemoryScope } from '../../core/memory/MemoryEntry.js';
import { extensionPoints } from '../../core/plugin-host/ExtensionPoints.js';
import { TokenCounter } from '../../core/context/TokenCounter.js';
import type { Session } from '../../core/session/index.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';
import { selectRunnableAgent } from '../../core/agent/AgentSelection.js';

// ---------------------------------------------------------------------------
// Internal helpers for send-message flow
// ---------------------------------------------------------------------------

/**
 * Collect agent output and return as single JSON response (non-streaming mode).
 *
 * Iterates the agent's async generator for the given session, accumulating all
 * text, thinking, and events. Once the stream completes, persists the assistant
 * message to the session store and returns the collected content as a JSON body.
 *
 * @param sessionId   - Target session ID.
 * @param agentId     - Agent to run.
 * @param userMessage - User message to submit.
 * @param history     - Conversation history (already persisted).
 * @param res         - HTTP response object.
 * @param sendJson    - JSON response helper.
 */
async function collectAndRespond(
  sessionId: string,
  agentId: string,
  userMessage: Message,
  history: Message[],
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  const runtime = AgentRuntime.getInstance();
  const registry = AgentRegistry.getInstance();
  const agent = registry.agent(agentId);

  if (!agent) {
    sendJson(res, 404, { error: 'Not Found', message: `Agent '${agentId}' not found` });
    return;
  }

  let fullText = '';
  let thinkContent = '';
  const events: SSEEvent[] = [];

  try {
    for await (const event of runtime.processMessage(
      sessionId,
      agentId,
      userMessage,
      history,
    )) {
      events.push(event);
      if (event.type === SSEEventType.Text) {
        fullText += (event.content as string) || '';
      }
      if (event.type === SSEEventType.Think) {
        thinkContent += (event.content as string) || '';
      }
      if (event.type === SSEEventType.Error) {
        fullText += `[Error: ${event.errorMessage as string}]`;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Agent Error', message });
    return;
  }

  // For reasoning models: if there is thinking content but no final text, use the last part of thinking as answer
  const responseContent = fullText || (thinkContent ? thinkContent.split('\n').slice(-10).join('\n') : '');

  // Persist assistant message
  if (responseContent.trim() || events.length > 0) {
    const sessionManager = SessionManager.getInstance();
    const assistantMessage: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: MessageRole.Assistant,
      content: responseContent.trim() || '(tool calls)',
      tokenCount: 0,
      compressed: false,
      timestamp: new Date().toISOString(),
      thinking: thinkContent.trim() || undefined,
    };
    await sessionManager.appendMessage(sessionId, assistantMessage).catch(err => {
      LogManager.getInstance().logger('anochat.api').error('Failed to persist API assistant message', { sid: sessionId, error: (err as Error).message });
    });
  }

  sendJson(res, 200, {
    sessionId,
    agentId,
    content: responseContent,
    think: thinkContent || undefined,
    events: events.length,
    timestamp: new Date().toISOString(),
  });
}

/** Stream agent output — WebSocket primary channel, HTTP SSE fallback */
async function streamResponse(
  sessionId: string,
  agentId: string,
  userMessage: Message,
  history: Message[],
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  const runtime = AgentRuntime.getInstance();
  const registry = AgentRegistry.getInstance();
  const agent = registry.agent(agentId);

  if (!agent) {
    sendJson(res, 404, { error: 'Not Found', message: `Agent '${agentId}' not found` });
    return;
  }

  const wsServer = WsServer.getInstance();
  const useWS = wsServer.isConnected(sessionId);

  // If using WebSocket, immediately return accepted status
  if (useWS) {
    sendJson(res, 202, {
      status: 'accepted',
      sessionId,
      agentId,
      message: 'Streaming via WebSocket',
    });
  } else {
    // HTTP SSE fallback (for REST API callers without WebSocket)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  const sendFrame = (data: Record<string, unknown>): void => {
    if (useWS) {
      wsServer.send(sessionId, data);
    } else {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  let assistantText = '';
  let thinkContent = '';
  let lastTokenUsage: TokenBreakdown | null = null;

  try {
    for await (const event of runtime.processMessage(
      sessionId,
      agentId,
      userMessage,
      history,
    )) {
      const payload: Record<string, unknown> = { type: event.type };

      switch (event.type) {
        case SSEEventType.Think:
          thinkContent += (event.content as string) || '';
          payload.content = event.content as string;
          break;
        case SSEEventType.Text:
          assistantText += (event.content as string) || '';
          payload.content = event.content as string;
          break;
        case SSEEventType.ToolCall:
          payload.toolName = event.toolName as string;
          payload.params = event.params as Record<string, unknown>;
          break;
        case SSEEventType.ToolResult:
          payload.toolName = event.toolName as string;
          payload.content = event.content as string;
          payload.success = event.success as boolean;
          payload.durationMs = event.durationMs as number;
          break;
        case SSEEventType.TodoWrite:
          payload.todos = event.todos as unknown[];
          break;
        case SSEEventType.Error:
          payload.errorMessage = event.errorMessage as string;
          payload.code = event.code as string;
          break;
        case SSEEventType.Done:
          payload.turnCount = event.turnCount as number;
          payload.tokenUsage = event.tokenUsage;
          lastTokenUsage = event.tokenUsage as TokenBreakdown;
          break;
        default:
          for (const [k, v] of Object.entries(event)) {
            if (k !== 'type') payload[k] = v;
          }
          break;
      }

      sendFrame(payload);
    }

    // Persist tokenUsage to session meta so page refresh loads correct stats
    if (lastTokenUsage) {
      const store = JsonlStore.getInstance();
      await store.updateMeta(sessionId, { tokenBreakdown: lastTokenUsage }).catch(err => {
        LogManager.getInstance().logger('anochat.api').error('Failed to persist token breakdown', { sid: sessionId, error: (err as Error).message });
      });
    }

    // Final done frame
    sendFrame({ type: 'done', session_id: sessionId, agent_id: agentId });

    // Persist assistant message
    if (assistantText.trim() || thinkContent.trim()) {
      const sessionManager = SessionManager.getInstance();
      const content = assistantText.trim() || '(reasoning only)';
      const assistantMessage: Message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        role: MessageRole.Assistant,
        content,
        tokenCount: TokenCounter.estimate(content),
        compressed: false,
        timestamp: new Date().toISOString(),
        thinking: thinkContent.trim() || undefined,
      };
      await sessionManager.appendMessage(sessionId, assistantMessage).catch(err => {
        LogManager.getInstance().logger('anochat.api').error('Failed to persist API stream assistant message', { sid: sessionId, error: (err as Error).message });
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendFrame({ type: 'error', errorMessage: message, code: 'AGENT_ERROR' });
  } finally {
    if (!useWS) res.end();
  }
}

// ---------------------------------------------------------------------------
// Exported handler functions
// ---------------------------------------------------------------------------

/** GET /api/v1/sessions */
export function handleListSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string,
): void {
  const url = new URL(req.url || '/', `http://${host}`);
  const statusParam = url.searchParams.get('status');
  const sessionManager = SessionManager.getInstance();

  let sessions;
  if (statusParam) {
    sessions = sessionManager.listSessions(statusParam as SessionStatus);
  } else {
    sessions = sessionManager.activeSessions();
  }

  sendJson(res, 200, {
    sessions: sessions.map((s) => ({
      id: s.id,
      type: s.type,
      status: s.status,
      title: s.title,
      agentId: s.agentId,
      workspace: s.workspace,
      parentSessionId: s.parentSessionId,
      parentId: s.parentSessionId,
      level: s.level,
      isMain: s.type === 'Main',
      canWrite: s.type === 'Main',
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      // Session-scoped product state (Goal, permission/effort mode, etc.) must
      // survive a renderer reload. Real-time events keep this current while the
      // app is open, but the list response is the cold-start source of truth.
      metadata: s.metadata,
    })),
    total: sessions.length,
  });
}

/** POST /api/v1/sessions */
export async function handleCreateSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  const body = await readBody(req);
  const sessionManager = SessionManager.getInstance();

  const agentSelection = selectRunnableAgent((body.agent_id as string) || (body.agentId as string) || '');
  if (!agentSelection.ok || !agentSelection.agentId) {
    sendJson(res, 409, { error: 'Agent Required', message: agentSelection.message || 'No runnable agent is configured' });
    return;
  }
  const agentId = agentSelection.agentId;
  const title: string = (body.title as string) || (body.name as string) || 'API Session';
  const parentId: string | undefined = body.parentSessionId as string | undefined
    || body.parent_id as string | undefined
    || body.parentId as string | undefined;

  try {
    let session: Session;
    if (parentId) {
      session = await sessionManager.createSubSession(parentId, agentId, title);
    } else {
      session = await sessionManager.createMainSession(agentId, title);
    }

    // Notify frontend via TypedEventBus → WsForwardSubscriber
    TypedEventBus.emit('session:created', {
      sessionId: session.id,
      parentSessionId: session.parentSessionId || undefined,
      agentId: session.agentId,
    });

    sendJson(res, 201, {
      id: session.id,
      type: session.type,
      status: session.status,
      title: session.title,
      agentId: session.agentId,
      parentSessionId: session.parentSessionId,
      level: session.level,
      workspace: session.workspace,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: 'Bad Request', message });
  }
}

/** GET /api/v1/sessions/:id */
export function handleGetSession(
  sessionId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const sessionManager = SessionManager.getInstance();
  const session = sessionManager.session(sessionId);

  if (!session) {
    sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
    return;
  }

  sendJson(res, 200, {
    id: session.id,
    type: session.type,
    status: session.status,
    title: session.title,
    agentId: session.agentId,
    workspace: session.workspace,
    parentSessionId: session.parentSessionId,
    level: session.level,
    subSessionIds: session.subSessionIds,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    metadata: session.metadata,
  });
}

/** DELETE /api/v1/sessions/:id */
export async function handleArchiveSession(
  sessionId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  const sessionManager = SessionManager.getInstance();
  const session = sessionManager.session(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
    return;
  }

  try {
    await sessionManager.archiveSession(sessionId);
    TypedEventBus.emit('session:archived', { sessionId });
    sendJson(res, 200, {
      status: 'archived',
      sessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Archive Failed', message });
  }
}

/** POST /api/v1/sessions/clear — Permanently delete all sessions */
export async function handleClearAllSessions(
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;

  const sessionManager = SessionManager.getInstance();

  // Delete from disk first — if this fails, memory stays intact
  const store = SessionStore.getInstance();
  let count = 0;
  try {
    count = await store.deleteAllSessions();
  } catch (err) {
    LogManager.getInstance().logger('anochat.api').error('deleteAllSessions failed', { error: (err as Error).message });
  }

  // Clear from memory after disk deletion succeeds
  sessionManager.clearAll();

  sendJson(res, 200, {
    status: 'cleared',
    deleted: count,
    timestamp: new Date().toISOString(),
  });
}

/** PATCH /api/v1/sessions/:id — Rename session */
export async function handleRenameSession(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWs(sessionId, res, sendJson)) return;

  try {
    const sessionManager = SessionManager.getInstance();
    const session = sessionManager.session(sessionId);

    if (!session) {
      sendJson(res, 404, { error: "Not Found", message: `Session '${sessionId}' not found` });
      return;
    }

    const body = await readBody(req);
    const title = body.title as string;
    if (!title || !title.trim()) {
      sendJson(res, 400, { error: "Bad Request", message: "title is required" });
      return;
    }

    await sessionManager.setTitle(sessionId, title.trim());
    sendJson(res, 200, { sessionId, title: session.title });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Internal Server Error', message });
  }
}

/** POST /api/v1/sessions/:id/auto-title — Auto-generate session title using LLM */
export async function handleAutoTitle(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWs(sessionId, res, sendJson)) return;
  try {
    const sessionManager = SessionManager.getInstance();
    const session = sessionManager.session(sessionId);

    if (!session) {
      sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
      return;
    }

    const body = await readBody(req);
    const message = (body.message as string) || '';
    if (!message.trim()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'message is required' });
      return;
    }

    // Get main agent (or first available agent) from registry for LLM config
    const registry = AgentRegistry.getInstance();
    const agent = registry.mainAgent() || registry.allAgents()[0];

    if (!agent) {
      sendJson(res, 500, { error: 'Internal Server Error', message: 'No agent available for title generation' });
      return;
    }

    // Generate title via the same streaming provider the agent uses.
    // Using raw fetch fails on DeepSeek reasoning models because the answer
    // goes into reasoning_content which consumes all max_tokens before content appears.
    // The provider correctly separates think_delta (reasoning) from text_delta (answer).
    let generatedTitle = '';
    const provider = createLLMProvider(agent.provider, extensionPoints);
    try {
      for await (const event of provider.chat(
        [{ role: 'user', content: message }],
        [],
        'Generate a concise session title in 3-8 words. Output ONLY the title, no explanation, no quotes.',
        {
          model: agent.modelName, maxTokens: 200, temperature: 0.3,
          contextWindow: agent.contextWindow, apiUrl: agent.apiUrl, apiKey: agent.apiKey,
        } as LLMOptions,
      )) {
        if (event.type === 'text_delta' && event.content) generatedTitle += event.content;
        if (event.type === 'error') break;
      }
    } catch (err) {
      // provider.chat handles AbortError internally, but distinguish network errors
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          // Expected — agent loop cancelled. Fall through to fallback.
        } else {
          LogManager.getInstance().logger('anochat.api').warn('Auto-title LLM error', { sid: sessionId, error: err.message });
        }
      }
    }

    if (!generatedTitle.trim()) {
      // Fallback: truncate message text
      generatedTitle = message.slice(0, 30).trim();
    }

    // Clean title: strip whitespace and quotes
    generatedTitle = generatedTitle.trim().replace(/^["']|["']$/g, '').trim();

    // Update session title
    await sessionManager.setTitle(sessionId, generatedTitle);

    sendJson(res, 200, { title: generatedTitle });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Internal Server Error', message });
  }
}

/** GET /api/v1/sessions/:id/messages */
export async function handleSessionMessages(
  sessionId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  const sessionManager = SessionManager.getInstance();
  const session = sessionManager.session(sessionId);

  if (!session) {
    sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
    return;
  }

  try {
    const messages = await sessionManager.getHistory(sessionId, true);
    const meta = await JsonlStore.getInstance().getMeta(sessionId);
    sendJson(res, 200, {
      sessionId,
      messages,
      total: messages.length,
      tokenBreakdown: meta.tokenBreakdown || null,
      isStreaming: AgentRuntime.getInstance().isSessionActive(sessionId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Load Failed', message });
  }
}

/** POST /api/v1/sessions/:id/messages — WS streaming (primary channel) or SSE fallback */
export async function handleSendMessage(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  const body = await readBody(req);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const attachments = Array.isArray(body.attachments) ? body.attachments as IncomingAttachment[] : undefined;
  if (!hasSendableUserPayload(content, attachments)) {
    sendJson(res, 400, { error: 'Bad Request', message: 'Missing "content" or "attachments" field' });
    return;
  }

  // ── Require WebSocket connection ──
  // All write operations go through WS to leverage the full pipeline:
  // StreamPersister (JSONL persistence), auto-title, workspace, etc.
  const wsServer = WsServer.getInstance();
  if (!wsServer.isConnected(sessionId)) {
    sendJson(res, 503, {
      error: 'WebSocket Required',
      message: 'A WebSocket connection is required to send messages. Open the AnoClaw frontend or connect via WS before using this endpoint.',
    });
    return;
  }

  const sessionManager = SessionManager.getInstance();
  let session = sessionManager.session(sessionId);
  if (!session) {
    // Auto-create session if it doesn't exist (matching WS handler behavior)
    const agentSelection = selectRunnableAgent();
    if (!agentSelection.ok || !agentSelection.agentId) {
      sendJson(res, 409, { error: 'Agent Required', message: agentSelection.message || 'No runnable agent is configured' });
      return;
    }
    const agentId = agentSelection.agentId;
    try {
      session = await sessionManager.createMainSession(agentId, content.slice(0, 30) || 'API Session');
    } catch (err) {
      sendJson(res, 500, { error: 'Session Creation Failed', message: (err as Error).message });
      return;
    }
    // Bind workspace to project root since this is an API-driven session
    try {
      await sessionManager.setWorkspace(session.id, process.cwd());
    } catch { /* best-effort */ }
  }

  // ── Dispatch through WS handler (full pipeline: StreamPersister + streaming) ──
  const dispatchResult = sendMessageHandler({
    sessionId: session.id,
    type: 'send_message',
    data: {
      content,
      mode: (body.mode as string) || 'auto',
      effort: (body.effort as boolean) ?? true,
      attachments,
      parentSessionId: body.parentSessionId as string | undefined,
    },
    ws: wsServer,
  });
  if (dispatchResult instanceof Promise) {
    dispatchResult.catch(err => {
      LogManager.getInstance().logger('anochat.api').error('WS sendMessageHandler failed', { sid: session.id, error: (err as Error).message });
    });
  }

  sendJson(res, 202, {
    status: 'accepted',
    sessionId: session.id,
    agentId: session.agentId,
    message: 'Streaming via WebSocket',
  });
}

/**
 * GET /api/v1/sessions/:id/tool-stats
 * Returns per-tool timing breakdown for a session — calls, avg/max/min, recent traces.
 */
export function handleSessionToolStats(
  sessionId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const profiler = ToolProfiler.getInstance();
  const stats = profiler.stats(sessionId);
  if (!stats) {
    sendJson(res, 200, { sessionId, totalCalls: 0, tools: {}, note: 'No tool calls recorded yet for this session.' });
    return;
  }
  sendJson(res, 200, stats as unknown as Record<string, unknown>);
}

/**
 * GET /api/v1/tool-stats
 * Returns global aggregate tool timing across all sessions.
 */
export function handleGlobalToolStats(
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const profiler = ToolProfiler.getInstance();
  const agg = profiler.globalAggregate();
  sendJson(res, 200, agg as unknown as Record<string, unknown>);
}

/**
 * GET /api/v1/search?q=...&scope=all&limit=20&agent=ceo&fuzzy=true
 * Unified search across sessions (titles + messages) and memories (team + agent).
 * Uses fuse.js fuzzy matching when fuzzy=true (default).
 *
 * Parameters:
 *   q       — search query (required)
 *   scope   — "sessions" | "memories" | "all" (default: "all")
 *   limit   — max results (default: 20, max: 100)
 *   agent   — filter memories to a specific agent (default: search all agents)
 *   fuzzy   — enable fuzzy matching (default: true)
 *
 * Returns: { results: Array<{ sourceType, sourceId, title, excerpt, score, meta }>, query }
 */
export async function handleSearchSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string = 'localhost',
  port: number = 3456,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const query = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const scope = url.searchParams.get('scope') || 'all';
    const agentFilter = url.searchParams.get('agent') || '';
    const fuzzy = url.searchParams.get('fuzzy') !== 'false';

    if (!query) {
      sendJson(res, 200, { results: [], query });
      return;
    }

    const results: SearchResult[] = [];

    // ── Search sessions ──
    if (scope === 'sessions' || scope === 'all') {
      await searchSessions(query, limit, results);
    }

    // ── Search memories ──
    if (scope === 'memories' || scope === 'all') {
      await searchMemories(query, limit, agentFilter, results);
    }

    // ── Score and rank ──
    const sorted = fuzzy
      ? rankResults(results, query)
      : substringRank(results, query);

    const final = sorted.slice(0, limit);

    sendJson(res, 200, { results: final, query, total: results.length, returned: final.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Search failed', message });
  }
}

// ── Result type ──

interface SearchResult {
  sourceType: 'session' | 'memory';
  sourceId: string;
  title: string;
  excerpt: string;
  score: number;
  matchField: string;
  meta: Record<string, unknown>;
}

// ── Session search ──

async function searchSessions(
  query: string,
  limit: number,
  results: SearchResult[],
): Promise<void> {
  const q = query.toLowerCase();
  const sessionManager = SessionManager.getInstance();
  const store = SessionStore.getInstance();
  const allSessions = sessionManager.listSessions();
  const MAX_EVENTS = 500;

  for (const session of allSessions) {
    if (session.isArchived()) continue;
    if (results.length >= limit * 2) break; // twice limit during raw search, rank later

    // Match title
    if ((session.title || '').toLowerCase().includes(q)) {
      results.push({
        sourceType: 'session',
        sourceId: session.id,
        title: session.title,
        excerpt: `Session: ${session.title}`,
        score: 0,
        matchField: 'title',
        meta: { sessionType: session.type, agentId: session.agentId, status: session.status },
      });
      continue;
    }

    // Search message content
    try {
      const events = await store.loadHistory(session.id);
      const recentEvents = events.slice(-MAX_EVENTS);
      let found = false;

      for (const ev of recentEvents) {
        if (found) break;
        const content = extractEventText(ev);
        if (content && content.toLowerCase().includes(q)) {
          const snippet = buildSnippet(content, q);
          results.push({
            sourceType: 'session',
            sourceId: session.id,
            title: session.title,
            excerpt: snippet,
            score: 0,
            matchField: 'content',
            meta: { sessionType: session.type, agentId: session.agentId, status: session.status },
          });
          found = true;
        }
      }
    } catch {
      // Session has no messages yet — skip
    }
  }
}

// ── Memory search ──

async function searchMemories(
  query: string,
  limit: number,
  agentFilter: string,
  results: SearchResult[],
): Promise<void> {
  const mm = MemoryManager.getInstance();

  // Collect team memories
  const teamEntries = await mm.search('system', MemoryScope.Team, query);
  for (const e of teamEntries.slice(0, limit)) {
    results.push({
      sourceType: 'memory',
      sourceId: `team:${e.name}`,
      title: e.name,
      excerpt: e.content.slice(0, 250),
      score: 0,
      matchField: 'content',
      meta: { scope: 'team', type: e.type, name: e.name },
    });
  }

  // Collect agent personal memories
  const registry = AgentRegistry.getInstance();
  const agents = agentFilter
    ? [registry.agent(agentFilter)].filter(Boolean)
    : registry.allAgents();

  for (const agent of agents) {
    if (!agent) continue;
    const agentEntries = await mm.search(agent.id, MemoryScope.Agent, query);
    for (const e of agentEntries.slice(0, limit)) {
      results.push({
        sourceType: 'memory',
        sourceId: `agent:${agent.id}:${e.name}`,
        title: `${agent.name || agent.id}: ${e.name}`,
        excerpt: e.content.slice(0, 250),
        score: 0,
        matchField: 'content',
        meta: { scope: 'personal', agentId: agent.id, agentName: agent.name, type: e.type, name: e.name },
      });
    }
  }
}

// ── Ranking ──

function rankResults(results: SearchResult[], query: string): SearchResult[] {
  try {
    // Simple scoring: exact match boost + word overlap
    const q = query.toLowerCase();
    const qTokens = new Set(q.split(/\s+/).filter(t => t.length >= 2));

    for (const r of results) {
      const text = (r.title + ' ' + r.excerpt).toLowerCase();

      // Exact substring match → high base score
      if (text.includes(q)) {
        r.score = 0.6;
      }

      // Word overlap bonus (Jaccard)
      const textTokens = new Set(text.split(/\s+/).filter(t => t.length >= 2));
      const intersection = [...qTokens].filter(t => textTokens.has(t)).length;
      const union = new Set([...qTokens, ...textTokens]).size;
      const overlap = union > 0 ? intersection / union : 0;

      r.score += overlap * 0.3;

      // Title match boost
      if (r.matchField === 'title') r.score += 0.1;

      // Clamp
      r.score = Math.round(Math.min(1, r.score) * 1000) / 1000;
    }
  } catch {
    // Fallback: keep scores at 0 (raw order)
  }

  return results.sort((a, b) => b.score - a.score);
}

function substringRank(results: SearchResult[], query: string): SearchResult[] {
  const q = query.toLowerCase();
  for (const r of results) {
    const text = (r.title + ' ' + r.excerpt).toLowerCase();
    r.score = text.includes(q) ? 0.7 : 0.3;
  }
  return results.sort((a, b) => b.score - a.score);
}

function buildSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, 200);
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

function extractEventText(ev: unknown): string | null {
  const msg = (ev as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map(b => (b.text || b.thinking || '') as string)
      .join(' ');
  }
  return null;
}

/** GET /api/v1/sessions/:id/overview — Session overview: messages, tokens, tool calls */
export async function handleGetOverview(
  sessionId: string,
  res: http.ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  const sessionManager = SessionManager.getInstance();
  const session = sessionManager.session(sessionId);
  const agentRegistry = AgentRegistry.getInstance();

  if (!session) {
    sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
    return;
  }

  const agent = agentRegistry.agent(session.agentId);
  const agentName = agent?.name || session.agentId;

  let messageCount = 0;
  let toolCallCount = 0;
  let totalTokens = 0;
  let compactCount = 0;
  const memoryRefCounts = new Map<string, number>();
  const skillRefCounts = new Map<string, number>();
  const todos: Array<{ content: string; status: string; activeForm: string }> = [];
  let lastHeartbeat = session.lastActiveAt || '';

  try {
    const history = await sessionManager.getHistory(sessionId);
    messageCount = history.length;

    for (const msg of history) {
      totalTokens += msg.tokenCount || 0;
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
      const hasToolResults = msg.toolResults && msg.toolResults.length > 0;
      if (hasToolCalls || hasToolResults) {
        toolCallCount += (msg.toolCalls?.length || 0) + (msg.toolResults?.length || 0);
        const toolNames = (msg.toolCalls || []).map(tc => tc.toolName);
        for (const name of toolNames) {
          if (name && (name.toLowerCase().includes('memory') || name === 'ReadMemories' || name === 'WriteMemory')) {
            memoryRefCounts.set(name, (memoryRefCounts.get(name) || 0) + 1);
          }
          if (name && (name.toLowerCase().includes('skill') || name === 'UseSkill')) {
            skillRefCounts.set(name, (skillRefCounts.get(name) || 0) + 1);
          }
        }
      }
      if (msg.content && msg.content.includes('Context compacted')) {
        compactCount++;
      }
      lastHeartbeat = msg.timestamp || lastHeartbeat;
    }
  } catch {
    // History loading is best-effort for overview
  }

  const memoryRefs = Array.from(memoryRefCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const skillRefs = Array.from(skillRefCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  sendJson(res, 200, {
    sessionId: session.id,
    agentName,
    status: session.status,
    type: session.type,
    level: session.level,
    parentSessionId: session.parentSessionId || null,
    messageCount,
    tokenCount: totalTokens,
    totalTokens,
    toolCallCount,
    compactCount,
    memoryRefs,
    skillRefs,
    todos: todos.slice(-8),
    lastHeartbeat,
    heartbeat: lastHeartbeat,
    taskCount: toolCallCount,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
  });
}
