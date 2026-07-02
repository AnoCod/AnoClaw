/**
 * AgentChannel — real-time typed messaging between agents.
 *
 * Replaces the polling-based inter-agent message detection in AgentLoop
 * with event-driven delivery via TypedEventBus. When agent A sends a
 * message to agent B via AgentChannel, B's AgentLoop receives it as an
 * injected message on the next message check — no polling delay.
 *
 * @module AgentChannel
 */

import { TypedEventBus } from '../events/index.js';

interface AgentMessage {
  targetAgentId: string;
  targetSessionId: string;
  sourceAgentId: string;
  sourceSessionId: string;
  content: string;
  role: 'system' | 'user';
  timestamp: string;
}

/** Callback invoked when a message arrives for a specific agent+session */
type MessageHandler = (msg: AgentMessage) => void;

/**
 * Singleton channel for real-time typed messaging between agents.
 * Subscribe to 'agent:message' events via TypedEventBus.
 */
export class AgentChannel {
  private static _instance: AgentChannel;
  private _handlers = new Map<string, Set<MessageHandler>>();

  static getInstance(): AgentChannel {
    if (!this._instance) this._instance = new AgentChannel();
    return this._instance;
  }

  private constructor() {
    // Subscribe to TypedEventBus for agent messages
    TypedEventBus.onAny((event, payload) => {
      if (event === 'agent:message') {
        const msg = payload as AgentMessage;
        this._deliver(msg);
      }
    });
  }

  /**
   * Send a message to another agent's session. The message is delivered
   * via TypedEventBus and picked up by the target agent's AgentChannel subscriber.
   */
  send(
    targetAgentId: string,
    targetSessionId: string,
    sourceAgentId: string,
    sourceSessionId: string,
    content: string,
    role: 'system' | 'user' = 'system',
  ): void {
    const msg: AgentMessage = {
      targetAgentId,
      targetSessionId,
      sourceAgentId,
      sourceSessionId,
      content,
      role,
      timestamp: new Date().toISOString(),
    };

    TypedEventBus.emit('agent:message', msg);
  }

  /**
   * Subscribe to messages addressed to a specific agent+session.
   * Returns an unsubscribe function.
   */
  subscribe(
    agentId: string,
    sessionId: string,
    handler: MessageHandler,
  ): () => void {
    const key = `${agentId}:${sessionId}`;
    if (!this._handlers.has(key)) {
      this._handlers.set(key, new Set());
    }
    this._handlers.get(key)!.add(handler);
    return () => {
      this._handlers.get(key)?.delete(handler);
    };
  }

  private _deliver(msg: AgentMessage): void {
    const key = `${msg.targetAgentId}:${msg.targetSessionId}`;
    const handlers = this._handlers.get(key);
    if (handlers) {
      for (const h of handlers) handlers.has(h) && h(msg);
    }
  }
}
