// MemoryExtension — Extension wrapper for the Memory subsystem

import type { Extension } from '../extensible/Extension.js';
import { createLogger } from '../logger.js';

const log = createLogger('anochat.memory.extension');

export class MemoryExtension implements Extension {
  readonly id = 'memory';
  readonly name = 'Memory System';
  readonly dependencies: string[] = [];
  private _running = false;

  async start(): Promise<void> {
    // MemoryManager is a singleton with no init step — always ready
    this._running = true;
    log.info('MemoryExtension started — MemoryManager ready');
  }

  async stop(): Promise<void> {
    this._running = false;
    log.info('MemoryExtension stopped');
  }

  isRunning(): boolean { return this._running; }
}
