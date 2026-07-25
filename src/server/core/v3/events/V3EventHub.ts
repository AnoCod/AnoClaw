import { EventEmitter } from 'node:events';
import type {
  CompanyEventEnvelope,
  WorkEventEnvelope,
} from '../../../../shared/types/v3/index.js';

export type V3DomainEnvelope = CompanyEventEnvelope | WorkEventEnvelope;

/**
 * Low-latency notification only. JSONL remains the source of truth and every
 * consumer must tolerate duplicate or missed live notifications by revision.
 */
export class V3EventHub extends EventEmitter {
  private static instance: V3EventHub | null = null;

  static getInstance(): V3EventHub {
    if (!this.instance) this.instance = new V3EventHub();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance?.removeAllListeners();
    this.instance = null;
  }

  publish(envelope: V3DomainEnvelope): void {
    this.emit('domainEvent', envelope);
  }

  subscribe(listener: (envelope: V3DomainEnvelope) => void): () => void {
    this.on('domainEvent', listener);
    return () => this.off('domainEvent', listener);
  }
}
