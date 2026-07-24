/**
 * InterruptController — manages AbortControllers for session interrupt.
 *
 * Moved from infra/supervision/ to core/agent/supervision/ — this is
 * agent lifecycle logic, not infrastructure.
 *
 * @module InterruptController
 */

import { createLogger } from '../../logger.js';

const log = createLogger('anochat.system');

/** Neutral interrupt marker — model decides whether to respond or continue working. */
export const INTERRUPT_MESSAGE = '[Request interrupted by user]';

/** Tool-use variant — signals that tools were cancelled mid-execution. */
export const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]\n\n';

/** Prefix for replaying a pending user message after a soft interrupt. */
export const INTERRUPT_MESSAGE_PREFIX = INTERRUPT_MESSAGE + '\n\n';

export enum InterruptReason {
  UserStop = 'user_stop',
  UserSteer = 'user_steer',
  ParentStop = 'parent_stop',
  Timeout = 'timeout',
}

export class InterruptController {
  private static _instance: InterruptController | null = null;

  static getInstance(): InterruptController {
    if (!InterruptController._instance) {
      InterruptController._instance = new InterruptController();
    }
    return InterruptController._instance;
  }

  private _controllers: Map<string, AbortController> = new Map();
  private _reasons: Map<string, InterruptReason> = new Map();
  private _parentMap: Map<string, string> = new Map();
  private _pendingMessages: Map<string, string> = new Map();

  private constructor() {
  }

  linkChild(parentSessionId: string, childSessionId: string): void {
    this._parentMap.set(childSessionId, parentSessionId);
  }

  unlinkChild(childSessionId: string): void {
    this._parentMap.delete(childSessionId);
  }

  createController(sessionId: string): AbortController {
    this._controllers.delete(sessionId);
    this._reasons.delete(sessionId);
    const controller = new AbortController();
    this._controllers.set(sessionId, controller);
    log.debug('Interrupt controller created', { sid: sessionId });
    return controller;
  }

  requestInterrupt(sessionId: string, reason: InterruptReason): void {
    this._interruptOne(sessionId, reason);
    for (const [childId, parentId] of this._parentMap) {
      if (parentId === sessionId) {
        this._interruptOne(childId, InterruptReason.ParentStop);
      }
    }
  }

  /** Abort every active controller during process shutdown. */
  interruptAll(reason: InterruptReason = InterruptReason.UserStop): void {
    for (const sessionId of [...this._controllers.keys()]) {
      this._interruptOne(sessionId, reason);
    }
  }

  /** Wake an idle agent session — interrupts ONLY this session, never cascades to children. */
  requestSteerInterrupt(sessionId: string): void {
    this.setPendingUserMessage(sessionId,
      '[System notification] A background task finished. Check the latest message for details.');
    this._interruptOne(sessionId, InterruptReason.UserSteer);
  }

  /** Abort without cascading to children and without setting a pending message.
   *  Caller should set their own pending message before calling this. */
  wakeOnly(sessionId: string): void {
    this._interruptOne(sessionId, InterruptReason.UserSteer);
  }

  private _interruptOne(sessionId: string, reason: InterruptReason): void {
    const controller = this._controllers.get(sessionId);
    if (!controller) return;
    if (!controller.signal.aborted) {
      controller.abort();
      this._reasons.set(sessionId, reason);
      log.info('Interrupt requested', { sid: sessionId, reason });
    }
  }

  getController(sessionId: string): AbortController | undefined {
    return this._controllers.get(sessionId);
  }

  removeController(sessionId: string): void {
    // Collect all descendant session IDs before deleting (avoid mutation during iteration)
    const descendants = this._collectDescendants(sessionId);

    // Remove the parent session itself
    this._controllers.delete(sessionId);
    this._reasons.delete(sessionId);
    this._parentMap.delete(sessionId);
    this._pendingMessages.delete(sessionId);

    // Remove all descendant sessions recursively
    for (const childId of descendants) {
      this._controllers.delete(childId);
      this._reasons.delete(childId);
      this._parentMap.delete(childId);
      this._pendingMessages.delete(childId);
    }

    log.debug('Interrupt controller removed', { sid: sessionId, descendants: descendants.size });
  }

  /** Collect all descendant session IDs (children, grandchildren, etc.) for the given session. */
  private _collectDescendants(sessionId: string): Set<string> {
    const result = new Set<string>();
    for (const [childId, parentId] of this._parentMap) {
      if (parentId === sessionId) {
        result.add(childId);
        // Recurse into grandchildren
        for (const grandchildId of this._collectDescendants(childId)) {
          result.add(grandchildId);
        }
      }
    }
    return result;
  }

  isInterrupted(sessionId: string): boolean {
    const controller = this._controllers.get(sessionId);
    return controller ? controller.signal.aborted : false;
  }

  reason(sessionId: string): InterruptReason | null {
    return this._reasons.get(sessionId) || null;
  }

  get activeCount(): number {
    return this._controllers.size;
  }

  setPendingUserMessage(sessionId: string, content: string): void {
    this._pendingMessages.set(sessionId, content);
  }

  takePendingUserMessage(sessionId: string): string | null {
    const msg = this._pendingMessages.get(sessionId) || null;
    this._pendingMessages.delete(sessionId);
    return msg;
  }

  hasPendingUserMessage(sessionId: string): boolean {
    return this._pendingMessages.has(sessionId);
  }
}
