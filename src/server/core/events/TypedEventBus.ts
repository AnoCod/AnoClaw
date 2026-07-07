/**
 * TypedEventBus — centralized publish/subscribe event bus.
 *
 * Replaces scattered EventEmitter usage with a single typed bus.
 * Core domain code emits events here instead of calling WsServer.send() directly.
 * Subscribers (WsForwardSubscriber, PluginFwd, LogSub, etc.) consume events.
 *
 * Thread-safety: Node.js is single-threaded (event loop). No locks needed.
 * Handler errors are caught and logged — one bad subscriber can't break the bus.
 */

import type { CoreEventMap } from '../../../shared/types/events.js';
import { createLogger } from '../logger.js';

type EventHandler<T> = (payload: T) => void;

export class TypedEventBusImpl {
  private _handlers = new Map<string, Set<EventHandler<any>>>();
  private _anyHandlers = new Set<(event: string, payload: unknown) => void>();
  private _logger = createLogger('anochat.events');

  // ── Singleton ──

  private static _instance: TypedEventBusImpl;

  static getInstance(): TypedEventBusImpl {
    if (!this._instance) this._instance = new TypedEventBusImpl();
    return this._instance;
  }

  /** Reset singleton (testing only). */
  static resetInstance(): void {
    if (TypedEventBusImpl._instance) {
      TypedEventBusImpl._instance._handlers.clear();
      TypedEventBusImpl._instance._anyHandlers.clear();
    }
    TypedEventBusImpl._instance = null!;
  }

  private constructor() {}

  // ── Publish ──

  /**
   * Emit a typed event. Payload type is enforced by CoreEventMap.
   * Plugin/unknown events fall through to the second overload.
   */
  emit<K extends keyof CoreEventMap>(event: K, payload: CoreEventMap[K]): void;
  emit(event: string, payload: unknown): void;
  emit(event: string, payload: unknown): void {
    const key = event as string;

    // Snapshot before iterating — a handler that unsubscribes another
    // handler would otherwise cause the second handler to be skipped.
    const handlers = this._handlers.get(key);
    if (handlers) {
      const snapshot = [...handlers];
      for (const h of snapshot) {
        try {
          h(payload);
        } catch (err) {
          this._logger.warn('TypedEventBus handler error', {
            event: key,
            error: (err as Error).message,
          });
        }
      }
    }

    // Snapshot any-handlers too — same unsubscribe-during-emit risk
    const anySnapshot = [...this._anyHandlers];
    for (const h of anySnapshot) {
      try {
        h(key, payload);
      } catch (err) {
        this._logger.warn('TypedEventBus any-handler error', {
          event: key,
          error: (err as Error).message,
        });
      }
    }
  }

  // ── Subscribe ──

  /**
   * Subscribe to a specific event. Returns an unsubscribe function.
   * Core events get typed payloads; plugin/unknown events get `unknown`.
   */
  on<K extends keyof CoreEventMap>(
    event: K,
    handler: EventHandler<CoreEventMap[K]>,
  ): () => void;
  on(event: string, handler: EventHandler<unknown>): () => void;
  on(event: string, handler: EventHandler<unknown>): () => void {
    const key = event as string;
    if (!this._handlers.has(key)) {
      this._handlers.set(key, new Set());
    }
    this._handlers.get(key)!.add(handler);
    return () => {
      const set = this._handlers.get(key);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this._handlers.delete(key);
      }
    };
  }

  /**
   * Subscribe to ALL events. For debugging, logging, plugin forwarding.
   * Returns an unsubscribe function.
   */
  onAny(handler: (event: string, payload: unknown) => void): () => void {
    this._anyHandlers.add(handler);
    return () => {
      this._anyHandlers.delete(handler);
    };
  }

  /** Number of specific event handlers registered. */
  get handlerCount(): number {
    let count = 0;
    for (const set of this._handlers.values()) count += set.size;
    return count;
  }

  /** Number of wildcard handlers registered. */
  get anyHandlerCount(): number {
    return this._anyHandlers.size;
  }
}

/** Singleton instance — use this everywhere. */
export const TypedEventBus = TypedEventBusImpl.getInstance();
