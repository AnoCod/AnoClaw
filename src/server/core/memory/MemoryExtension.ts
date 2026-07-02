// MemoryExtension — Extension wrapper for the Memory subsystem

import type { Extension } from '../extensible/Extension.js';

export class MemoryExtension implements Extension {
  readonly id = 'memory';
  readonly name = 'Memory System';
  readonly dependencies: string[] = [];
  private _running = false;

  async start(): Promise<void> {
    // MemoryManager is a singleton with no init step — always ready
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  isRunning(): boolean { return this._running; }
}
