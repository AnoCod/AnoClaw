// AnoClaw Frontend — Simple EventEmitter base class

/* eslint-disable @typescript-eslint/no-unsafe-function-type */
type EventHandler = Function;

import { ClientLogger } from './ClientLogger.js';

export class EventEmitter {
  private _listeners: Map<string, Set<EventHandler>> = new Map();
  private _emitDepth: Map<string, number> = new Map();
  private _maxListeners: number = 20;

  on(event: string, handler: EventHandler): this {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    if (set.size > this._maxListeners) {
      ClientLogger.app.warn('MaxListeners exceeded', { event, count: set.size, max: this._maxListeners });
    }
    return this;
  }

  off(event: string, handler: EventHandler): this {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    const depth = (this._emitDepth.get(event) ?? 0) + 1;
    if (depth > 10) {
      ClientLogger.app.warn('Circular emit detected', { event, depth });
      return;
    }
    this._emitDepth.set(event, depth);
    try {
      for (const handler of set) {
        try {
          handler(...args);
        } catch (e) {
          ClientLogger.app.error('Event handler error', { event, error: (e as Error).message });
        }
      }
    } finally {
      if (depth === 1) {
        this._emitDepth.delete(event);
      } else {
        this._emitDepth.set(event, depth - 1);
      }
    }
  }

  setMaxListeners(n: number): void {
    this._maxListeners = n;
  }

  getMaxListeners(): number {
    return this._maxListeners;
  }

  removeAllListeners(): void {
    this._listeners.clear();
  }

  listenerCount(event: string): number {
    return this._listeners.get(event)?.size ?? 0;
  }
}
