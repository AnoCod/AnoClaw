import type { ToolResult } from '../../../../shared/types/tool.js';
import type { TeamMembershipRole } from '../../../../shared/types/v3/index.js';
import { makeError } from '../ToolResult.js';
import { V3OrganizationApiError } from './V3OrganizationApiAdapter.js';

export class V3OrganizationToolInputError extends Error {
  readonly code = 'validation_failed';

  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'V3OrganizationToolInputError';
  }
}

export function organizationToolFailure(error: unknown): ToolResult {
  if (error instanceof V3OrganizationApiError) {
    return makeError(`${error.code}: ${error.message}`, {
      structured: {
        status: 'error',
        error: error.toStructured(),
      },
    });
  }
  if (error instanceof V3OrganizationToolInputError) {
    return makeError(`${error.code}: ${error.message}`, {
      structured: {
        status: 'error',
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeError(message, {
    structured: {
      status: 'error',
      error: {
        code: 'unexpected_error',
        message,
      },
    },
  });
}

export function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const result = optionalString(value, field, maxLength);
  if (!result) throw new V3OrganizationToolInputError(`${field} is required`, { field });
  return result;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new V3OrganizationToolInputError(`${field} must be a string`, { field });
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new V3OrganizationToolInputError(
      `${field} must be ${maxLength} characters or fewer`,
      { field, maxLength },
    );
  }
  return normalized;
}

export function optionalStringArray(
  value: unknown,
  field: string,
  options: { maxItems: number; maxLength: number },
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new V3OrganizationToolInputError(`${field} must be an array`, { field });
  }
  if (value.length > options.maxItems) {
    throw new V3OrganizationToolInputError(
      `${field} must have ${options.maxItems} items or fewer`,
      { field, maxItems: options.maxItems },
    );
  }
  return [...new Set(value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new V3OrganizationToolInputError(
        `${field}[${index}] must be a non-empty string`,
        { field, index },
      );
    }
    const normalized = item.trim();
    if (normalized.length > options.maxLength) {
      throw new V3OrganizationToolInputError(
        `${field}[${index}] must be ${options.maxLength} characters or fewer`,
        { field, index, maxLength: options.maxLength },
      );
    }
    return normalized;
  }))];
}

export function membershipRole(value: unknown): TeamMembershipRole {
  if (value === undefined || value === null || value === '') return 'member';
  if (value !== 'leader' && value !== 'member') {
    throw new V3OrganizationToolInputError(
      'membershipRole must be leader or member',
      { field: 'membershipRole' },
    );
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new V3OrganizationToolInputError(`${field} must be a boolean`, { field });
  }
  return value;
}

export function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new V3OrganizationToolInputError(`${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new V3OrganizationToolInputError(
      `${field} contains unsupported fields: ${unknown.join(', ')}`,
      { field, unknownFields: unknown },
    );
  }
}
