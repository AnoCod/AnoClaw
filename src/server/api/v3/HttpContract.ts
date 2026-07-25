import type { IncomingMessage, ServerResponse } from 'node:http';
import { V3ApiError, errorEnvelope, toV3ApiError, validationError } from './ApiError.js';

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export interface Revisioned<T> {
  data: T;
  revision: number;
}

export interface JsonResponse {
  status?: number;
  body?: unknown;
  revision?: number;
  headers?: Record<string, string>;
}

export async function readJsonObject(
  req: IncomingMessage,
  options: { allowEmpty?: boolean; maxBytes?: number } = {},
): Promise<JsonObject> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredType = headerValue(req, 'content-type');
  if (declaredType && !declaredType.toLowerCase().startsWith('application/json')) {
    throw new V3ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        rejectOnce(new V3ApiError(413, 'body_too_large', `JSON body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    req.on('error', (error) => rejectOnce(error));
    req.on('aborted', () => rejectOnce(new V3ApiError(400, 'bad_request', 'Request body was aborted')));
  });

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    if (options.allowEmpty) return {};
    throw new V3ApiError(400, 'invalid_json', 'A JSON object body is required');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new V3ApiError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (!isJsonObject(parsed)) {
    throw new V3ApiError(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return parsed;
}

export function parseExpectedRevision(
  req: IncomingMessage,
  body: JsonObject,
  options?: { required?: true },
): number;
export function parseExpectedRevision(
  req: IncomingMessage,
  body: JsonObject,
  options: { required: false },
): number | undefined;
export function parseExpectedRevision(
  req: IncomingMessage,
  body: JsonObject,
  options: { required?: boolean } = {},
): number | undefined {
  const header = headerValue(req, 'if-match');
  const headerRevision = header === undefined ? undefined : parseIfMatch(header);
  const bodyRevision = body.expectedRevision === undefined
    ? undefined
    : parseRevision(body.expectedRevision, 'expectedRevision');

  if (headerRevision !== undefined && bodyRevision !== undefined && headerRevision !== bodyRevision) {
    throw new V3ApiError(
      400,
      'bad_request',
      'If-Match and expectedRevision must identify the same revision',
    );
  }
  const revision = headerRevision ?? bodyRevision;
  if (revision === undefined && options.required !== false) {
    throw new V3ApiError(
      428,
      'precondition_required',
      'Provide If-Match or expectedRevision for this mutation',
    );
  }
  return revision;
}

export function parseAfterRevision(url: URL): number {
  return parseNonNegativeQuery(url, 'afterRevision');
}

export function parseNonNegativeQuery(url: URL, field: string): number {
  const value = url.searchParams.get(field);
  if (value === null || value === '') return 0;
  if (!/^\d+$/.test(value)) {
    throw validationError(`${field} must be a non-negative integer`, {
      field,
    });
  }
  return Number(value);
}

export function requestInput(body: JsonObject): JsonObject {
  const { expectedRevision: _expectedRevision, ...input } = body;
  return input;
}

export function requireString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} is required`, { field });
  }
  return value.trim();
}

export function optionalString(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string`, { field });
  }
  return value.trim() || undefined;
}

export function optionalBoolean(body: JsonObject, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw validationError(`${field} must be a boolean`, { field });
  }
  return value;
}

export function optionalStringArray(body: JsonObject, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw validationError(`${field} must be an array of non-empty strings`, { field });
  }
  return value.map((entry) => entry.trim());
}

export function optionalNonNegativeInteger(body: JsonObject, field: string): number | undefined {
  if (body[field] === undefined) return undefined;
  return requireNonNegativeInteger(body, field);
}

export function optionalObject(body: JsonObject, field: string): JsonObject | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw validationError(`${field} must be an object`, { field });
  }
  return value;
}

export function requireNonNegativeInteger(body: JsonObject, field: string): number {
  return parseRevision(body[field], field);
}

export function requirePositiveInteger(body: JsonObject, field: string): number {
  const value = parseRevision(body[field], field);
  if (value === 0) {
    throw validationError(`${field} must be a positive integer`, { field });
  }
  return value;
}

export function assertAllowedFields(body: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set([...allowed, 'expectedRevision']);
  const unexpected = Object.keys(body).filter((field) => !allowedSet.has(field));
  if (unexpected.length > 0) {
    throw validationError('Request contains unsupported fields', { fields: unexpected });
  }
}

export function requireOneString(body: JsonObject, fields: readonly string[]): string {
  for (const field of fields) {
    const value = optionalString(body, field);
    if (value) return value;
  }
  throw validationError(`One of ${fields.join(', ')} is required`, { fields });
}

export function assertNonEmptyPatch(body: JsonObject): void {
  if (Object.keys(requestInput(body)).length === 0) {
    throw validationError('At least one field must be provided');
  }
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
  const status = response.status ?? 200;
  const body = response.body === undefined ? null : response.body;
  const encoded = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(encoded)),
    'Cache-Control': 'no-store',
    ...response.headers,
  };
  if (response.revision !== undefined) headers.ETag = formatEtag(response.revision);
  res.writeHead(status, headers);
  res.end(encoded);
}

export function sendV3Error(res: ServerResponse, error: unknown): void {
  const apiError = toV3ApiError(error);
  sendJson(res, {
    status: apiError.status,
    body: errorEnvelope(apiError),
  });
}

export function formatEtag(revision: number): string {
  return `"${parseRevision(revision, 'revision')}"`;
}

export function revisioned<T>(data: T, revision: number): Revisioned<T> {
  return { data, revision: parseRevision(revision, 'revision') };
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseIfMatch(value: string): number {
  const trimmed = value.trim();
  const match = /^(?:W\/)?"(\d+)"$/.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) {
    throw new V3ApiError(
      400,
      'bad_request',
      'If-Match must contain one numeric revision ETag',
    );
  }
  return Number(match[1]);
}

function parseRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative integer`, { field });
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
