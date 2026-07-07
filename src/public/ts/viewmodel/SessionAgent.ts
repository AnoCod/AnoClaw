
// Each session has its own SessionAgent with its own EventEmitter, SessionState,
// and WS event handlers. No global pointer swap, no silent emit, no shared state.
//
// Modeled after Claude Code's Agent instances and Hermes' SessionEntry.

import { EventEmitter } from '../EventEmitter.js';
import { SessionState } from './SessionState.js';
import type { Message, TokenBreakdown, TodoItem } from '../types.js';
import { MessageListModel } from './MessageListModel.js';
import { ClientLogger } from '../ClientLogger.js';
import { ToastManager } from '../ToastManager.js';
import type { SessionViewModel } from './SessionViewModel.js';
import type { WSClient } from './WSClient.js';

// Re-export these so ConversationWsHandlers can be pure functions operating on SessionAgent
export { ClientLogger, ToastManager };

let _idSeq = 0;

/** Generate a unique message ID: msg_<timestamp>_<counter>. */
export function generateId(): string {
  return 'msg_' + Date.now().toString(36) + '_' + (_idSeq++).toString(36);
}

/** Seal the current thinking block: record duration, mark success, emit update. */
export function finalizeThink(agent: SessionAgent): void {
  const s = agent.state;
  if (s.currentThinkMsg) {
    s.currentThinkMsg.durationMs = Date.now() - s.thinkStartTime;
    s.currentThinkMsg.status = 'success';
    const idx = s.messages.indexOf(s.currentThinkMsg.id);
    if (idx !== -1) s.messages.updateMessage(idx, s.currentThinkMsg);
    agent.emit('messageUpdated', s.currentThinkMsg);
    s.currentThinkMsg = null;
  }
}

/** Seal the current streaming text segment so a new one can start. Fires textSegmentFinalized. */
export function finalizeTextSegment(agent: SessionAgent): void {
  const s = agent.state;
  if (s.streamMsgId) {
    const msg = findMessageById(agent, s.streamMsgId);
    if (msg) {
      agent.emit('textSegmentFinalized', msg);
    }
  }
}

/** Find a message by ID in the agent's message list. */
export function findMessageById(agent: SessionAgent, id: string): Message | undefined {
  return agent.state.messages.messages.find(m => m.id === id);
}

/** Remove the inline status indicator card from the message list. */
export function removeStatusCard(agent: SessionAgent): void {
  const idx = agent.state.messages.indexOf('status-indicator');
  if (idx !== -1) agent.state.messages.removeMessage(idx);
}


// Each handler is a pure function: takes an agent, mutates its state,
// and fires events on its emitter so the UI (SessionsPage) can react.

/** Handle a 'think' event: create or accumulate a thinking block message. */
export function onThink(agent: SessionAgent, content: string, durationMs?: number): void {
  const s = agent.state;
  if (!s.currentThinkMsg) {
    // Start a new think block
    s.thinkStartTime = Date.now();
    const msg: Message = {
      id: generateId(), sessionId: agent.sessionId, type: 'think', content, timestamp: Date.now(), durationMs,
      agentId: agent.agentId,
      status: 'pending',
    };
    s.currentThinkMsg = msg;
    s.messages.appendMessage(msg);
    agent.emit('messageAdded', msg);
  } else {
    // Append to existing think block
    s.currentThinkMsg.content += content;
    if (durationMs) s.currentThinkMsg.durationMs = durationMs;
    const idx = s.messages.indexOf(s.currentThinkMsg.id);
    if (idx !== -1) { s.messages.updateMessage(idx, s.currentThinkMsg); agent.emit('messageUpdated', s.currentThinkMsg); }
  }
}

/** Handle a 'text' event: start or continue a streaming assistant message.
 *  First token starts streaming + fires streamingStarted. Subsequent tokens append. */
export function onText(agent: SessionAgent, content: string): void {
  const s = agent.state;
  if (!s.isStreaming) {
    s.isStreaming = true;
    s.generationSeq++;
    s.streamMsgId = null;
    s.currentStreamMessage = '';
    agent.emit('streamingStarted');
  }
  if (!s.streamMsgId) {

    s.streamMsgId = generateId();
    const msg: Message = {
      id: s.streamMsgId, sessionId: agent.sessionId, type: 'message', role: 'assistant', content, timestamp: Date.now(),
      agentId: agent.agentId,
    };
    s.currentStreamMessage = content;
    s.messages.appendMessage(msg);
  } else {
    // Append token to existing message
    s.currentStreamMessage += content;
    const idx = s.messages.indexOf(s.streamMsgId);
    if (idx !== -1) {
      const existing = s.messages.messages[idx];
      if (existing) { existing.content = s.currentStreamMessage; s.messages.updateMessage(idx, existing); }
    }
  }
  agent.emit('streamToken', content);
}


export function onToolCall(agent: SessionAgent, id: string, name: string, input: Record<string, unknown>): void {
  finalizeThink(agent);
  finalizeTextSegment(agent);
  agent.state.streamMsgId = null;

  // TodoWrite updates the shared todo list, not a tool card
  if (name === 'TodoWrite' && input.todos) { onTodoWrite(agent, input.todos as TodoItem[]); return; }

  const msg: Message = {
    id: generateId(), sessionId: agent.sessionId, type: 'tool_call', toolName: name, toolId: id,
    toolInput: input, content: '', status: 'pending', timestamp: Date.now(),
    agentId: agent.agentId,
  };
  agent.state.messages.appendMessage(msg);
  agent.emit('messageAdded', msg);
}

/** Handle a 'tool_result' event: match to the pending tool_call by ID, update status + duration. */
export function onToolResult(agent: SessionAgent, id: string, name: string, content: string, status: string): void {
  if (name === 'TodoWrite' || name === 'AskUserQuestion') return;
  finalizeThink(agent);
  finalizeTextSegment(agent);
  agent.state.streamMsgId = null;
  // Walk backwards to find the matching tool_call
  const messages = agent.state.messages.messages as Message[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'tool_call' && m.toolId === id) {
      m.status = (status === 'success' ? 'success' : 'error') as Message['status'];
      m.content = content;
      m.durationMs = Date.now() - m.timestamp;
      agent.state.messages.updateMessage(i, m);
      agent.emit('messageUpdated', m);
      break;
    }
  }
  agent.emit('toolResult', { toolName: name, status, content });
}

/** Handle a 'done' event: stop streaming, finalize think/text, update token breakdown. */
export function onDone(agent: SessionAgent, tokenUsage?: TokenBreakdown): void {
  const s = agent.state;
  if (!s.isStreaming) return;
  s.isStreaming = false;
  finalizeThink(agent);
  finalizeTextSegment(agent);
  s.streamMsgId = null;


  if (tokenUsage) {
    s.tokenBreakdown = { ...tokenUsage };
    agent.emit('tokensUpdated', s.tokenBreakdown);
  }
  removeStatusCard(agent);
  agent.emit('streamingStopped');
}

/** Handle an 'error' event: stop streaming, show error message.
 *  Non-fatal codes (already processing, active loop) are silently ignored. */
export function onError(agent: SessionAgent, data: { message?: string; code?: string; errorMessage?: string }): void {
  const message = data.message || data.errorMessage || '';
  const nonFatalCodes = new Set(['SESSION_ALREADY_PROCESSING', 'SESSION_ACTIVE_LOOP']);
  if (data.code && nonFatalCodes.has(data.code)) {
    ClientLogger.vm.debug('Ignoring non-fatal error', { code: data.code, message: message.slice(0, 80) });
    return;
  }
  if (!agent.state.isStreaming) {

    const fatalMsg: Message = {
      id: generateId(), sessionId: agent.sessionId, type: 'error',
      content: message || 'API request failed -- check your API key and URL in Agents settings.',
      timestamp: Date.now(),
      agentId: agent.agentId,
    };
    agent.state.messages.appendMessage(fatalMsg);
    agent.emit('messageAdded', fatalMsg);
    return;
  }
  agent.state.isStreaming = false;
  agent.state.streamMsgId = null;
  finalizeThink(agent);

  const msg: Message = {
    id: generateId(), sessionId: agent.sessionId, type: 'error',
    content: message || 'API request failed -- check your API key and URL in Agents settings.',
    timestamp: Date.now(),
    agentId: agent.agentId,
  };
  agent.state.messages.appendMessage(msg);
  agent.emit('messageAdded', msg);
  removeStatusCard(agent);
  agent.emit('streamingStopped');
}

/** Handle a 'plan_enter' event: show a plan mode boundary card. */
export function onPlanEnter(agent: SessionAgent, title: string): void {
  const msg: Message = {
    id: generateId(), sessionId: agent.sessionId, type: 'plan_enter', planTitle: title,
    content: `Plan mode: ${title}`, timestamp: Date.now(),
    agentId: agent.agentId,
  };
  agent.state.messages.appendMessage(msg);
  agent.emit('messageAdded', msg);
}

/** Handle a 'plan_exit' event: show a plan mode exit card. */
export function onPlanExit(agent: SessionAgent): void {
  const msg: Message = {
    id: generateId(), sessionId: agent.sessionId, type: 'plan_exit', content: 'Plan mode exited', timestamp: Date.now(),
    agentId: agent.agentId,
  };
  agent.state.messages.appendMessage(msg);
  agent.emit('messageAdded', msg);
}

/** Replace all todo_write messages with the latest todo list. */
export function onTodoWrite(agent: SessionAgent, todos: TodoItem[]): void {
  const msgs = agent.state.messages.messages;
  // Remove old todo_write messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'todo_write') agent.state.messages.removeMessage(i);
  }
  const msg: Message = {
    id: generateId(), sessionId: agent.sessionId, type: 'todo_write', content: '', todos, timestamp: Date.now(),
    agentId: agent.agentId,
  };
  agent.state.messages.appendMessage(msg);
  agent.emit('messageAdded', msg);
}

/** Handle delegation progress: show/update a live activity card for a sub-agent. */
export function onDelegationProgress(agent: SessionAgent, data: Record<string, unknown>): void {
  const subSessionId = data.subSessionId as string;
  const subAgentId = data.subAgentId as string;
  const originalType = data.originalType as string;
  const content = (data.content || '') as string;
  const toolName = data.toolName as string | undefined;

  const delegationMsgId = `delegation-${subSessionId}`;
  const existing = agent.state.messages.indexOf(delegationMsgId);
  const displayContent = formatDelegationContent(subAgentId, originalType, content, toolName);

  if (existing === -1) {

    const dMsg: Message = {
      id: delegationMsgId, sessionId: agent.sessionId, type: 'delegation_activity', content: displayContent,
      subAgentId, subSessionId, timestamp: Date.now(),
      agentId: agent.agentId,
    } as Message;
    agent.state.messages.appendMessage(dMsg);
    agent.emit('messageAdded', dMsg);
  } else {
    // Update existing card in place
    const msg = agent.state.messages.getMessage(existing)!;
    msg.content = displayContent;
    msg.timestamp = Date.now();
    agent.state.messages.updateMessage(existing, msg);
    agent.emit('messageUpdated', msg);
  }
}

/** Handle delegation status change: emit status update, remove activity card on completion/error. */
export function onDelegationStatus(agent: SessionAgent, data: Record<string, unknown>): void {
  const subSessionId = data.subSessionId as string;
  const phase = data.phase as string;

  agent.emit('delegationStatusUpdate', { subSessionId, phase });

  // Completion/failure toasts are now handled by task_notification cards + desktop notifications.
  // Only clean up the inline delegation activity card.

  if (phase === 'completed' || phase === 'error') {
    const delegationMsgId = `delegation-${subSessionId}`;
    const idx = agent.state.messages.indexOf(delegationMsgId);
    if (idx !== -1) { agent.state.messages.removeMessage(idx); agent.emit('messageRemoved', delegationMsgId); }
  }
}

/** Handle a task_notification event: show a completion/failure card from a sub-agent. */
export function onTaskNotification(agent: SessionAgent, data: Record<string, unknown>): void {
  const taskId = (data.taskId as string) || '';
  const parentSessionId = (data.parentSessionId as string) || '';
  const parentAgentId = (data.parentAgentId as string) || '';
  const status = (data.taskStatus as string) || 'completed';
  const summary = (data.taskSummary as string) || 'Unknown task';
  const result = (data.taskResult as string) || '';
  const msgId = `task-notif-${taskId || Date.now().toString(36)}`;

  const msg: Message = {
    id: msgId,
    sessionId: agent.sessionId,
    type: 'task_notification',
    content: JSON.stringify({ taskId, parentSessionId, parentAgentId, status, summary, result }),
    taskId,
    parentSessionId,
    parentAgentId,
    taskStatus: status,
    taskSummary: summary,
    taskResult: result,
    agentId: parentAgentId || agent.agentId,
    timestamp: Date.now(),
  };

  const existingIdx = agent.state.messages.indexOf(msgId);
  if (existingIdx >= 0) {

    agent.state.messages.updateMessage(existingIdx, msg);
    agent.emit('messageUpdated', msg);
  } else {
    agent.state.messages.appendMessage(msg);
    agent.emit('messageAdded', msg);
  }
}

/** Handle a generic status event: show or update a status-indicator card while streaming. */
export function onStatus(agent: SessionAgent, content?: string): void {
  if (!content || !agent.state.isStreaming) return;
  const statusId = 'status-indicator';
  const existingIdx = agent.state.messages.indexOf(statusId);
  if (existingIdx !== -1) {
    const msg = agent.state.messages.messages[existingIdx];
    if (msg) { msg.content = content; agent.state.messages.updateMessage(existingIdx, msg); agent.emit('messageUpdated', msg); }
  } else {
    const statusMsg: Message = { id: statusId, sessionId: agent.sessionId, type: 'status', content, timestamp: Date.now(), agentId: agent.agentId };
    agent.state.messages.appendMessage(statusMsg);
    agent.emit('messageAdded', statusMsg);
  }
}

/** Handle a 'sleep' event: show the goal-mode idle card. */
export function onSleep(agent: SessionAgent, content?: string): void {
  const msg = content || 'Goal active -- waiting before next step';
  const statusId = 'goal-status';
  const existingIdx = agent.state.messages.indexOf(statusId);
  if (existingIdx !== -1) {
    const m = agent.state.messages.messages[existingIdx];
    if (m) { m.content = msg; agent.state.messages.updateMessage(existingIdx, m); agent.emit('messageUpdated', m); }
  } else {
    const statusMsg: Message = { id: statusId, sessionId: agent.sessionId, type: 'status', content: msg, timestamp: Date.now(), agentId: agent.agentId };
    agent.state.messages.appendMessage(statusMsg);
    agent.emit('messageAdded', statusMsg);
  }
}

/** Handle a 'wake' event: resume streaming + update the goal-mode card to show activity. */
export function onWake(agent: SessionAgent, content?: string): void {
  agent.state.isStreaming = true;
  finalizeThink(agent);
  const msg = content || 'Goal wake -- continuing active goal';
  const statusId = 'goal-status';
  const existingIdx = agent.state.messages.indexOf(statusId);
  if (existingIdx !== -1) {
    const m = agent.state.messages.messages[existingIdx];
    if (m) { m.content = msg; agent.state.messages.updateMessage(existingIdx, m); agent.emit('messageUpdated', m); }
  } else {
    const statusMsg: Message = { id: statusId, sessionId: agent.sessionId, type: 'status', content: msg, timestamp: Date.now(), agentId: agent.agentId };
    agent.state.messages.appendMessage(statusMsg);
    agent.emit('messageAdded', statusMsg);
  }
}

/** Format a delegation activity card's content based on the original event type. */
function formatDelegationContent(
  subAgentId: string,
  originalType: string,
  content: string,
  toolName?: string,
): string {
  const agentLabel = subAgentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  switch (originalType) {
    case 'think': return `[think] ${agentLabel} is thinking...`;
    case 'text': return `[text] ${agentLabel}: ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`;
    case 'tool_call': return `[tool] ${agentLabel} -> ${toolName || 'tool'}()`;
    case 'tool_result': return `[done] ${agentLabel} <- ${toolName || 'tool'} completed`;
    case 'error': return `[error] ${agentLabel}: ${content.slice(0, 100)}`;
    default: return `[busy] ${agentLabel} working...`;
  }
}



export class SessionAgent extends EventEmitter {
  readonly sessionId: string;
  /** Per-session mutable state: messages, streaming flags, token breakdown, etc. */
  readonly state: SessionState;

  private _sessionVM: SessionViewModel | null = null;
  /** Prevent concurrent sendMessage calls for the same session. */
  private _sendingLock = false;

  get agentId(): string | undefined {
    return this._sessionVM?.sessions.getById(this.sessionId)?.agentId;
  }

  constructor(sessionId: string, sessionVM: SessionViewModel) {
    super();
    console.log('[SessionAgent] Agent constructed', { sessionId });
    this.sessionId = sessionId;
    this.state = new SessionState(sessionId);
    this._sessionVM = sessionVM;
    // Forward model trim events so UI can clean up DOM
    this.state.messages.on('rowsRemoved', (start: number, count: number, ids?: string[]) => {
      this.emit('rowsRemoved', start, count, ids);
    });
  }



  /** Handle a WS event for THIS session. No global swap, no silent mode.
   *  Dispatches to the matching handler function, which mutates this.state
   *  and fires events on this agent's own emitter.
   *  SessionsPage subscribes directly to these events for UI updates. */
  onServerEvent(eventType: string, data: Record<string, unknown>): void {
    console.debug('[SessionAgent] WS event received', { eventType, sessionId: this.sessionId });
    try {
      switch (eventType) {
        case 'think': onThink(this, data.content as string, data.durationMs as number | undefined); break;
        case 'text': onText(this, data.content as string); break;
        case 'tool_call': onToolCall(
          this,
          (data.id || data.toolCallId || data.toolId || '') as string,
          (data.name || data.toolName || '') as string,
          (data.input || data.params || data.args || data.toolInput || {}) as Record<string, unknown>,
        ); break;
        case 'tool_result': onToolResult(this, (data.toolCallId || data.id || '') as string, (data.toolName || data.name || '') as string, (data.result || data.content || '') as string, (data.success !== false ? 'success' : 'error')); break;
        case 'done': onDone(this, data.tokenUsage as TokenBreakdown | undefined); break;
        case 'error': onError(this, data as { message?: string; code?: string; errorMessage?: string }); break;
        case 'plan_enter': onPlanEnter(this, data.title as string); break;
        case 'plan_exit': onPlanExit(this); break;
        case 'todo_write': onTodoWrite(this, data.todos as TodoItem[]); break;
        case 'delegation_progress': onDelegationProgress(this, data); break;
        case 'delegation_status': onDelegationStatus(this, data); break;
        case 'task_notification': onTaskNotification(this, data); break;
        case 'status': onStatus(this, data.content as string | undefined); break;
        case 'sleep': onSleep(this, data.content as string | undefined); break;
        case 'wake': onWake(this, data.content as string | undefined); break;
      }
    } catch (err) {
      ClientLogger.vm.error('Error handling WS event in SessionAgent', {
        eventType, sessionId: this.sessionId, error: (err as Error).message,
      });
    }
  }



  /** Build the user message, wire attachments, send via WS, start streaming.
   *  Auto-generates a session title for unnamed sessions. Guarded by _sendingLock. */
  async sendMessage(inputValue: string, permissionMode: string, effortMode: boolean, attachments: { name: string; path: string; type: string; size: number; content?: string }[]): Promise<void> {
    if (!inputValue.trim() && attachments.length === 0) return;
    if (this._sendingLock) return;

    console.log('[SessionAgent] sendMessage', { sessionId: this.sessionId, inputLen: inputValue.length });

    const content = inputValue.trim();
    let displayContent = content || '(attachments)';
    let effectiveContent = content;
    // If attachments have inlined content, prepend them to the message text
    if (attachments.length > 0) {
      const fileTexts = attachments.filter(a => a.content).map(a => `[File: ${a.name}]\n${a.content}`);
      if (fileTexts.length > 0) {
        const prefix = fileTexts.join('\n\n');
        effectiveContent = content ? prefix + '\n\n' + content : prefix;
      } else {
        const names = attachments.map(a => a.name).join(', ');
        displayContent = content || `[Attached: ${names}]`;
        effectiveContent = displayContent;
      }
    }
    const userMsg: Message = {
      id: generateId(), sessionId: this.sessionId, type: 'message', role: 'user', content: displayContent, timestamp: Date.now(),
      agentId: this.agentId,
    };

    this._sendingLock = true;

    try {
      const vm = this._sessionVM;
      if (!vm) throw new Error('SessionAgent._sessionVM is null -- agent not properly initialized');
      const targetSessionId = this.sessionId;
      const node = vm.sessions.getById(targetSessionId);
      await vm.ensureRunnableAgentForSession(targetSessionId);


      if (node && (node.title === 'New Session' || !node.title || node.title === content.slice(0, 30))) {
        this._generateSessionTitle(targetSessionId, content).then(title => {
          if (title) vm.renameSession(targetSessionId, title).catch(() => {});
        });
      }

      if (!this._sendingLock) return;

      const wsClient = vm.getWSClient();
      if (!wsClient || !wsClient.connected) {
        throw new Error('WebSocket is not connected. Please wait for reconnection or refresh the page.');
      }

      this.state.messages.appendMessage(userMsg);


      finalizeThink(this);
      this.state.streamMsgId = null;
      this.state.currentStreamMessage = '';

      wsClient.sendMessage(this.sessionId, content, permissionMode, effortMode, attachments);
      ClientLogger.vm.debug('Message sent via WS', { sid: this.sessionId, mode: permissionMode, contentLen: content.length });

      this.emit('messageAdded', userMsg);
      this.state.isStreaming = true;
      this.state.generationSeq++;
      this.emit('streamingStarted');
    } catch (err) {
      console.error('[SessionAgent] sendMessage failed', { sessionId: this.sessionId, error: (err as Error).message });
      ClientLogger.vm.error('Send failed', { error: (err as Error).message });
      this.state.messages.appendMessage({
        id: generateId(), sessionId: this.sessionId, type: 'error',
        content: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now(),
        agentId: this.agentId,
      });
      ToastManager.getInstance().error(err instanceof Error ? err.message : String(err));
    } finally {
      this._sendingLock = false;
    }
  }

  /** Call the auto-title API endpoint to generate a name for a new session. */
  private async _generateSessionTitle(sessionId: string, message: string): Promise<string | null> {
    try {
      const resp = await fetch(`/api/v1/sessions/${sessionId}/auto-title`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return (data.title as string) || null;
    } catch (e) {
      ClientLogger.vm.warn('Auto-title generation failed', { sid: sessionId, error: (e as Error).message });
      return null;
    }
  }



  /** Stop the current generation: send stop to backend, finalize state, emit streamingStopped. */
  async stopGeneration(): Promise<void> {
    console.log('[SessionAgent] stopGeneration', { sessionId: this.sessionId });
    ClientLogger.vm.debug('Stopping generation', { sid: this.sessionId });
    if (!this._sessionVM) return;
    this._sessionVM.getWSClient().stopGeneration(this.sessionId);
    this.state.isStreaming = false;
    this.state.streamMsgId = null;
    finalizeThink(this);
    this.state.generationSeq++;
    removeStatusCard(this);
    this.emit('streamingStopped');
  }



  /** Fetch stored messages for this session from the backend. Aborts any in-flight load.
   *  Reconstructs the message list, streaming state, and token breakdown. */
  async loadHistory(): Promise<void> {
    const s = this.state;
    // Abort any in-progress load before starting a new one
    if (s.loadAbortController) s.loadAbortController.abort();
    s.loadAbortController = new AbortController();
    const signal = s.loadAbortController.signal;

    // Reset state for fresh load
    s.messages.clear();
    s.isStreaming = false;
    s.currentStreamMessage = '';
    s.tokenBreakdown = null;
    s.streamMsgId = null;
    s.currentThinkMsg = null;
    s.generationSeq++;

    this.emit('reset');

    this.emit('historyLoading', { sessionId: this.sessionId });

    ClientLogger.vm.debug('Loading conversation history', { sid: this.sessionId });
    try {
      const resp = await fetch(`/api/v1/sessions/${this.sessionId}/messages`, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (signal.aborted) return;
      // Ingest stored messages one by one, handling flat/structured formats
      for (const m of (data.messages || [])) this._ingestStoredMessage(m);
      if (data.tokenBreakdown) {
        s.tokenBreakdown = {
          systemPrompt: (data.tokenBreakdown.systemPrompt as number) || 0,
          systemTools: (data.tokenBreakdown.systemTools as number) || 0,
          skills: (data.tokenBreakdown.skills as number) || 0,
          messages: (data.tokenBreakdown.messages as number) || 0,
          total: (data.tokenBreakdown.total as number) || 0,
          contextWindow: (data.tokenBreakdown.contextWindow as number)
            || (((data.tokenBreakdown.total as number) || 0) + ((data.tokenBreakdown.freeSpace as number) || 0)),
          freeSpace: (data.tokenBreakdown.freeSpace as number) || 0,
        };
      }
      ClientLogger.vm.debug('Conversation history loaded', { sid: this.sessionId, messageCount: (data.messages || []).length });
      this.emit('historyLoaded', { sessionId: this.sessionId });
      if (s.tokenBreakdown) this.emit('tokensUpdated', s.tokenBreakdown);
    } catch (e) {
      if (signal.aborted) return;
      ClientLogger.vm.error('Failed to load conversation history', { sid: this.sessionId, error: (e as Error).message });
      this.emit('historyLoadError', { sessionId: this.sessionId, error: (e as Error).message });
    }
  }

  /** Convert a stored message (flat or tool-call-rich) into the UI message model.
   *  Handles three flat formats (think-only, tool-call-only, text-only)
   *  and the full structured format with interleaved thinking + tool calls + text + results. */
  private _ingestStoredMessage(m: any): void {
    const s = this.state;
    const ts = typeof m.timestamp === 'string' ? new Date(m.timestamp).getTime() : Date.now();
    const sessionId = String(m.sessionId || this.sessionId);
    const agentId = (m.agentId as string | undefined) || this.agentId;
    const agentName = m.agentName as string | undefined;
    // Todo-write: replace all existing todos with the stored set
    if (m.type === 'todo_write') {
      if (Array.isArray(m.todos)) {
        const msgs = s.messages.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].type === 'todo_write') s.messages.removeMessage(i);
        }
        s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'todo_write', content: '', todos: m.todos as TodoItem[], timestamp: ts, agentId, agentName });
      }
      return;
    }
    if (m.type === 'error') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'error', content: String(m.content || m.error || 'Unknown error'), timestamp: ts, agentId, agentName });
      return;
    }
    if (m.type === 'plan_enter') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'plan_enter', content: String(m.content || ''), planTitle: String(m.planTitle || m.title || 'Plan Mode'), timestamp: ts, agentId, agentName });
      return;
    }
    if (m.type === 'plan_exit') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'plan_exit', content: String(m.content || 'Plan mode exited'), timestamp: ts, agentId, agentName });
      return;
    }
    if (m.type === 'status') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'status', content: String(m.content || ''), timestamp: ts, agentId, agentName });
      return;
    }

    if (m.role === 'user') {
      const rawContent = String(m.content || '');
      if (rawContent.startsWith('<task-notification>')) {
        const parsed = parseTaskNotificationXML(rawContent);
        if (parsed) {
          s.messages.appendMessage({
            id: m.id || generateId(),
            sessionId,
            type: 'task_notification',
            content: JSON.stringify(parsed),
            taskId: parsed.taskId || '',
            parentSessionId: m.sessionId || '',
            parentAgentId: m.agentId || '',
            taskStatus: parsed.status,
            taskSummary: parsed.summary,
            taskResult: parsed.result,
            timestamp: ts,
          });
          return;
        }
      }
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'message', role: 'user', content: rawContent, timestamp: ts, agentId, agentName });
      return;
    }
    if (m.role === 'system') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'message', role: 'system', content: String(m.content || ''), timestamp: ts, agentId, agentName });
      return;
    }
    if (m.role !== 'assistant') return;
    const tcs: any[] = Array.isArray(m.toolCalls) ? m.toolCalls : [];

    const isFlatThink = !tcs.length && !m.content && m.thinking;
    const isFlatToolCall = tcs.length > 0 && !m.content && !m.thinking;
    const isFlatText = !tcs.length && m.content && !m.thinking;
    if (isFlatThink) {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'think', content: String(m.thinking), timestamp: ts, durationMs: 0, agentId, agentName });
      return;
    }
    if (isFlatToolCall) {
      for (const tc of tcs) {
        if (!tc || typeof tc !== 'object') continue;
        const name = tc.toolName || tc.name || '';
        const input = tc.params || tc.input || {};
        const result = tc.result;
        if (name === 'TodoWrite' && input.todos) {
          s.messages.appendMessage({ id: generateId(), sessionId, type: 'todo_write', content: '', todos: input.todos as TodoItem[], timestamp: ts, agentId, agentName });
          continue;
        }
        if (name === 'AskUserQuestion') continue;
        s.messages.appendMessage({
          id: tc.id || generateId(), sessionId, type: 'tool_call', toolName: name, toolId: tc.id || '',
          toolInput: input, content: result && typeof result.content === 'string' ? result.content : '',
          status: result ? (result.success ? 'success' : 'error') : 'success', timestamp: ts,
          agentId, agentName,
        });
      }
      return;
    }
    // Structured format: thinking block, then text, then tool calls + results interleaved
    if (m.thinking) s.messages.appendMessage({ id: generateId(), sessionId, type: 'think', content: String(m.thinking), timestamp: ts, durationMs: 0, agentId, agentName });
    if (m.content && m.content !== '(tool calls)' && m.content !== '(reasoning only)') {
      s.messages.appendMessage({ id: m.id || generateId(), sessionId, type: 'message', role: 'assistant', content: String(m.content), timestamp: ts, agentId, agentName });
    }
    // Match tool results to their calls by id
    const trs: any[] = Array.isArray(m.toolResults) ? m.toolResults : [];
    const rm = new Map<string, any>();
    for (const tr of trs) if (tr && typeof tr === 'object') rm.set(String(tr.toolCallId || ''), tr);
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue;
      const tr = rm.get(String(tc.id || ''));
      const name = tc.toolName || tc.name || '';
      const input = tc.params || tc.input || {};
      if (name === 'TodoWrite' && input.todos) { s.messages.appendMessage({ id: generateId(), sessionId, type: 'todo_write', content: '', todos: input.todos as TodoItem[], timestamp: ts, agentId, agentName }); continue; }
      if (name === 'AskUserQuestion') continue;
      s.messages.appendMessage({
        id: tc.id || generateId(), sessionId, type: 'tool_call', toolName: name, toolId: tc.id || '',
        toolInput: input, content: tr && typeof tr.content === 'string' ? tr.content : '',
        status: tr ? (tr.success ? 'success' : 'error') : 'pending', timestamp: ts,
        agentId, agentName,
      });
    }
  }



  /** Handle WS disconnection mid-stream: stop streaming, show error card. */
  onConnectionLost(): void {
    if (!this.state.isStreaming) return;
    this.state.isStreaming = false;
    this.state.streamMsgId = null;
    finalizeThink(this);
    this._sendingLock = false;
    this.state.generationSeq++;
    removeStatusCard(this);
    const msg: Message = {
      id: generateId(), sessionId: this.sessionId, type: 'error',
      content: 'WebSocket connection lost. Please check your network and try again.', timestamp: Date.now(),
      agentId: this.agentId,
    };
    this.state.messages.appendMessage(msg);
    this.emit('messageAdded', msg);
    this.emit('streamingStopped');
  }

  /** Clear all state and notify UI. Used when the session is reset externally. */
  reset(): void {
    const s = this.state;
    s.messages.clear();
    s.isStreaming = false;
    s.currentStreamMessage = '';
    s.streamMsgId = null;
    s.currentThinkMsg = null;
    s.tokenBreakdown = null;
    s.generationSeq++;
    this.emit('reset');
  }

  /** Clean up: abort any in-flight load request and remove all event listeners. */
  destroy(): void {
    console.log('[SessionAgent] destroy', { sessionId: this.sessionId });
    if (this.state.loadAbortController) {
      this.state.loadAbortController.abort();
    }
    this.removeAllListeners();
  }
}

/** Extract fields from a <task-notification> XML string. Returns null if not parseable. */
function parseTaskNotificationXML(xml: string): { taskId: string; status: string; summary: string; result: string } | null {
  try {
    const tag = (name: string): string => {
      const m = xml.match(new RegExp(`<${name}>(.*?)</${name}>`, 's'));
      return (m?.[1] || '').trim();
    };
    const taskId = tag('task-id');
    if (!taskId) return null;
    return {
      taskId,
      status: tag('status') || 'unknown',
      summary: tag('summary') || '',
      result: tag('result') || '',
    };
  } catch {
    return null;
  }
}
