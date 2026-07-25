export type V3ErrorCode =
  | 'bad_request'
  | 'invalid_json'
  | 'body_too_large'
  | 'unsupported_media_type'
  | 'validation_failed'
  | 'precondition_required'
  | 'revision_conflict'
  | 'conflict'
  | 'not_found'
  | 'invalid_state'
  | 'forbidden'
  | 'internal_error';

export interface V3ErrorEnvelope {
  error: {
    code: V3ErrorCode | string;
    message: string;
    details?: unknown;
  };
}

export class V3ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: V3ErrorCode | string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'V3ApiError';
  }
}

const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  revision_conflict: 409,
  conflict: 422,
  already_exists: 409,
  event_id_conflict: 409,
  invalid_transition: 422,
  invalid_state: 422,
  invalid_argument: 422,
  sensitive_field: 422,
  validation: 422,
  validation_failed: 422,
  report_required: 422,
  report_empty: 422,
  report_mismatch: 422,
  report_not_submitted: 422,
  max_turns_exhausted: 422,
  reviewer_required: 422,
  reviewer_must_differ: 422,
  verification_required: 422,
  stale_attempt: 422,
  company_limit_reached: 422,
  mission_limit_reached: 422,
  agent_write_exclusive: 422,
  agent_read_limit_reached: 422,
  forbidden: 403,
};

interface CodedError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

/**
 * Convert domain/store failures into the single v3 error contract.
 * Not-found text is intentionally generic so a cross-company identifier never
 * reveals whether the referenced record exists in a different scope.
 */
export function toV3ApiError(error: unknown): V3ApiError {
  if (error instanceof V3ApiError) return error;

  if (error && typeof error === 'object') {
    const candidate = error as CodedError;
    const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : undefined;
    if (code && DOMAIN_STATUS[code]) {
      const status = DOMAIN_STATUS[code];
      if (status === 404) return notFound();
      const publicCode = code === 'validation' || code === 'invalid_argument' || code === 'sensitive_field'
        ? 'validation_failed'
        : code === 'conflict'
          ? 'invalid_state'
        : code === 'already_exists' || code === 'event_id_conflict'
          ? 'conflict'
          : code;
      const message = typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : defaultMessage(publicCode);
      return new V3ApiError(status, publicCode, message, candidate.details);
    }

    const explicitStatus = integerStatus(candidate.status) ?? integerStatus(candidate.statusCode);
    if (explicitStatus && explicitStatus >= 400 && explicitStatus < 500) {
      const publicCode = explicitStatus === 404
        ? 'not_found'
        : explicitStatus === 409
          ? 'revision_conflict'
          : explicitStatus === 422
            ? 'validation_failed'
            : 'bad_request';
      if (explicitStatus === 404) return notFound();
      const message = typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : defaultMessage(publicCode);
      return new V3ApiError(explicitStatus, publicCode, message, candidate.details);
    }
  }

  return new V3ApiError(500, 'internal_error', 'Internal server error');
}

export function notFound(resource = 'Resource'): V3ApiError {
  return new V3ApiError(404, 'not_found', `${resource} not found`);
}

export function validationError(message: string, details?: unknown): V3ApiError {
  return new V3ApiError(422, 'validation_failed', message, details);
}

export function errorEnvelope(error: V3ApiError): V3ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function integerStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function defaultMessage(code: string): string {
  if (code === 'revision_conflict') return 'The resource revision has changed';
  if (code === 'validation_failed') return 'Request validation failed';
  return 'Request could not be completed';
}
