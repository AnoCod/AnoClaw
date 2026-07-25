export type CoordinationErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'forbidden'
  | 'validation';

export class CoordinationError extends Error {
  constructor(
    public readonly code: CoordinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CoordinationError';
  }
}
