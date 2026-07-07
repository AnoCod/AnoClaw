/**
 * EventSubscriptionManager — topic-based pub/sub for agent event delivery.
 *
 * Any system component can publish events by topic. Subscribing agents
 * receive events via SessionManager.appendMessage() + InterruptController
 * soft interrupt, so the event is both persisted in session history and
 * delivered in real-time to a running agent.
 *
 * Topics are strings with colon-delimited namespacing by convention:
 *   "task:completed:<subSessionId>"
 *   "process:ready:<pid>"
 *   "pipeline:<id>:stage:<n>"
 *
 * V1: exact topic match only. No wildcard/glob support.
 *
 * @module EventSubscriptionManager
 */

import { SessionManager } from '../session/SessionManager.js';
import { InterruptController, InterruptReason } from '../agent/supervision/InterruptController.js';
import { TypedEventBus } from './TypedEventBus.js';
import { MessageRole } from '../../../shared/types/session.js';
import type { Message } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';

const log = createLogger('anochat.events');

export interface Subscription {
  /** Unique subscription ID (returned by subscribe(), used for unsubscribe) */
  id: string;
  /** Session that will receive the event */
  sessionId: string;
  /** Agent that will receive the event (stored for context/observability) */
  agentId: string;
  /** Exact topic string to match on publish */
  topic: string;
  /** If true, auto-unsubscribe after first delivery */
  oneShot: boolean;
  /** When this subscription was created */
  createdAt: number;
}

export class EventSubscriptionManager {
  private static _instance: EventSubscriptionManager | null = null;

  static getInstance(): EventSubscriptionManager {
    if (!EventSubscriptionManager._instance) {
      EventSubscriptionManager._instance = new EventSubscriptionManager();
    }
    return EventSubscriptionManager._instance;
  }

  static resetInstance(): void {
    if (EventSubscriptionManager._instance) {
      EventSubscriptionManager._instance._unsubArchiving?.();
      EventSubscriptionManager._instance._subscriptions.clear();
      EventSubscriptionManager._instance._byId.clear();
      EventSubscriptionManager._instance._bySession.clear();
      EventSubscriptionManager._instance._idCounter = 0;
    }
    EventSubscriptionManager._instance = null;
  }

  /** Map<topic, Set<Subscription>> */
  private _subscriptions = new Map<string, Set<Subscription>>();
  /** Map<subscriptionId, Subscription> for O(1) lookup by ID */
  private _byId = new Map<string, Subscription>();
  /** Map<sessionId, Set<topic>> for O(1) session→topics lookup */
  private _bySession = new Map<string, Set<string>>();
  /** Monotonic ID counter */
  private _idCounter = 0;
  /** Unsubscribe from the session:archiving event on reset */
  private _unsubArchiving?: () => void;

  private constructor() {
    // Clean up subscriptions when a session is archived — breaks our circular
    // dependency on SessionManager by listening through TypedEventBus instead.
    this._unsubArchiving = TypedEventBus.on('session:archiving', ({ sessionId }) => {
      this.unsubscribeAll(sessionId);
    });
  }

  /**
   * Subscribe a session+agent to a topic.
   * Returns a subscription ID that can be used to unsubscribe.
   */
  subscribe(
    sessionId: string,
    agentId: string,
    topic: string,
    options?: { oneShot?: boolean },
  ): string {
    const id = `sub-${++this._idCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const sub: Subscription = {
      id,
      sessionId,
      agentId,
      topic,
      oneShot: options?.oneShot ?? false,
      createdAt: Date.now(),
    };

    if (!this._subscriptions.has(topic)) {
      this._subscriptions.set(topic, new Set());
    }
    this._subscriptions.get(topic)!.add(sub);
    this._byId.set(id, sub);

    if (!this._bySession.has(sessionId)) {
      this._bySession.set(sessionId, new Set());
    }
    this._bySession.get(sessionId)!.add(topic);

    log.debug('Subscription created', { sid: sessionId, agentId, topic, id, oneShot: sub.oneShot });
    return id;
  }

  /**
   * Unsubscribe a specific subscription by ID, or all subscriptions for
   * a session+topic combo (convenience overload).
   *
   * Pass a string ID to remove one subscription.
   * Pass (sessionId, topic) to remove all subscriptions for that session+topic.
   */
  unsubscribe(subscriptionIdOrSession: string, topic?: string): boolean {
    if (topic !== undefined) {
      return this._unsubscribeBySessionTopic(subscriptionIdOrSession, topic);
    }
    return this._unsubscribeById(subscriptionIdOrSession);
  }

  private _unsubscribeById(id: string): boolean {
    const sub = this._byId.get(id);
    if (!sub) return false;

    const topicSet = this._subscriptions.get(sub.topic);
    if (topicSet) {
      topicSet.delete(sub);
      if (topicSet.size === 0) this._subscriptions.delete(sub.topic);
    }

    this._byId.delete(id);

    const sessionTopics = this._bySession.get(sub.sessionId);
    if (sessionTopics) {
      const remaining = [...this._byId.values()];
      const hasMore = remaining.some(s => s.sessionId === sub.sessionId && s.topic === sub.topic);
      if (!hasMore) {
        sessionTopics.delete(sub.topic);
        if (sessionTopics.size === 0) this._bySession.delete(sub.sessionId);
      }
    }

    log.debug('Subscription removed (by id)', { id, topic: sub.topic, sid: sub.sessionId });
    return true;
  }

  private _unsubscribeBySessionTopic(sessionId: string, topic: string): boolean {
    const topicSet = this._subscriptions.get(topic);
    if (!topicSet) return false;

    let found = false;
    for (const sub of topicSet) {
      if (sub.sessionId === sessionId) {
        topicSet.delete(sub);
        this._byId.delete(sub.id);
        found = true;
      }
    }

    if (topicSet.size === 0) this._subscriptions.delete(topic);

    const sessionTopics = this._bySession.get(sessionId);
    if (sessionTopics) {
      sessionTopics.delete(topic);
      if (sessionTopics.size === 0) this._bySession.delete(sessionId);
    }

    if (found) log.debug('Subscriptions removed (by session+topic)', { sid: sessionId, topic });
    return found;
  }

  /**
   * Remove all subscriptions for a given session.
   * Useful when a session ends or an agent is deactivated.
   */
  unsubscribeAll(sessionId: string): number {
    const sessionTopics = this._bySession.get(sessionId);
    if (!sessionTopics) return 0;

    let count = 0;
    for (const topic of sessionTopics) {
      const topicSet = this._subscriptions.get(topic);
      if (!topicSet) continue;
      for (const sub of topicSet) {
        if (sub.sessionId === sessionId) {
          topicSet.delete(sub);
          this._byId.delete(sub.id);
          count++;
        }
      }
      if (topicSet.size === 0) this._subscriptions.delete(topic);
    }

    this._bySession.delete(sessionId);
    log.debug('All subscriptions removed for session', { sid: sessionId, count });
    return count;
  }

  /**
   * Publish an event to all subscribers of the given topic.
   *
   * For each subscriber:
   *   1. Formats a system message: "[Event: topic] payload"
   *   2. Writes it to the subscriber's session via SessionManager.appendMessage()
   *   3. Triggers a soft interrupt so the agent sees it immediately
   *   4. If oneShot, removes the subscription
   *
   * Returns the number of subscribers that were notified.
   */
  async publish(topic: string, payload: unknown): Promise<number> {
    const topicSet = this._subscriptions.get(topic);
    if (!topicSet || topicSet.size === 0) {
      log.debug('Publish to empty topic (no subscribers)', { topic });
      return 0;
    }

    const subs = [...topicSet]; // snapshot for safe iteration
    const ic = InterruptController.getInstance();
    const sm = SessionManager.getInstance();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const eventContent = `[Event: ${topic}] ${payloadStr}`;

    let delivered = 0;
    for (const sub of subs) {
      try {
        const message: Message = {
          id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: sub.sessionId,
          role: MessageRole.System,
          content: eventContent,
          tokenCount: Math.ceil(eventContent.length / 4),
          compressed: false,
          timestamp: new Date().toISOString(),
          agentId: sub.agentId,
        };
        await sm.appendMessage(sub.sessionId, message);

        ic.setPendingUserMessage(sub.sessionId, eventContent);
        ic.wakeOnly(sub.sessionId);

        delivered++;
      } catch (err) {
        log.warn('Failed to deliver event to subscriber', {
          topic, sid: sub.sessionId, subId: sub.id, error: (err as Error).message,
        });
      } finally {
        if (sub.oneShot) {
          this._unsubscribeById(sub.id);
        }
      }
    }

    TypedEventBus.emit('subscription:delivered', {
      sessionId: subs[0]?.sessionId || '',
      agentId: subs[0]?.agentId || '',
      topic,
      subscriberCount: delivered,
    });

    log.info('Event published', { topic, delivered, subscriberCount: subs.length });
    return delivered;
  }

  /**
   * Check if a session has any subscription to a topic.
   */
  hasSubscription(sessionId: string, topic: string): boolean {
    const topicSet = this._subscriptions.get(topic);
    if (!topicSet) return false;
    return [...topicSet].some(sub => sub.sessionId === sessionId);
  }

  /**
   * List all subscriptions for a given session.
   */
  getSubscriptions(sessionId: string): Subscription[] {
    const result: Subscription[] = [];
    for (const topicSet of this._subscriptions.values()) {
      for (const sub of topicSet) {
        if (sub.sessionId === sessionId) result.push(sub);
      }
    }
    return result;
  }

  /** Total number of registered subscriptions. */
  get activeCount(): number {
    return this._byId.size;
  }

  /** Number of distinct topics with at least one subscriber. */
  get topicCount(): number {
    return this._subscriptions.size;
  }
}
