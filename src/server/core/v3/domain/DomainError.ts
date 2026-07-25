import type { V3DomainErrorCode } from '../../../../shared/types/v3/index.js';

export class V3DomainError extends Error {
  constructor(
    public readonly code: V3DomainErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'V3DomainError';
  }
}
