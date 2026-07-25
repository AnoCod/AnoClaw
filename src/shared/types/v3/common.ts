export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EventActor {
  type: 'user' | 'agent' | 'system';
  id: string;
}

export interface AppendEventOptions {
  expectedRevision: number;
  eventId?: string;
  occurredAt?: string;
  actor?: EventActor;
  correlationId?: string;
  causationId?: string;
}

export type V3DomainErrorCode =
  | 'ALREADY_EXISTS'
  | 'CONFLICT'
  | 'CORRUPT_EVENT_STREAM'
  | 'EVENT_ID_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'SENSITIVE_FIELD';
