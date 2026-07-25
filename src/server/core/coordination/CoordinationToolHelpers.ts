import type { ExecutionContext } from '../../../shared/types/session.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { Tool } from '../tools/Tool.js';
import { makeError } from '../tools/ToolResult.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { SessionManager } from '../session/SessionManager.js';
import { CoordinationError } from './CoordinationError.js';

export function rootSessionIdFor(ctx: ExecutionContext): string {
  return SessionManager.getInstance().getRootSession(ctx.sessionId).id;
}

export function requireActiveAgent(agentId: string): void {
  const agent = AgentRegistry.getInstance().findAgent(agentId);
  if (!agent?.isActive) throw new CoordinationError('validation', `Active agent not found: ${agentId}`);
}

export function toolFailure(tool: Tool, error: unknown): ToolResult {
  void tool;
  if (error instanceof CoordinationError) {
    return makeError(`${error.code}: ${error.message}`);
  }
  return makeError(error instanceof Error ? error.message : String(error));
}

export function stringParam(
  value: unknown,
  name: string,
  maxLength: number,
  optional = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new CoordinationError('validation', `${name} is required`);
  }
  if (typeof value !== 'string') throw new CoordinationError('validation', `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized && !optional) throw new CoordinationError('validation', `${name} is required`);
  if (normalized.length > maxLength) {
    throw new CoordinationError('validation', `${name} exceeds ${maxLength} characters`);
  }
  return normalized || undefined;
}

export function stringArrayParam(
  value: unknown,
  name: string,
  options: { optional?: boolean; maxItems?: number; maxLength?: number } = {},
): string[] {
  if (value === undefined || value === null) {
    if (options.optional) return [];
    throw new CoordinationError('validation', `${name} is required`);
  }
  if (!Array.isArray(value)) throw new CoordinationError('validation', `${name} must be an array`);
  const maxItems = options.maxItems ?? 50;
  const maxLength = options.maxLength ?? 2_000;
  if (value.length > maxItems) throw new CoordinationError('validation', `${name} exceeds ${maxItems} items`);
  return [...new Set(value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new CoordinationError('validation', `${name}[${index}] must be a non-empty string`);
    }
    if (entry.trim().length > maxLength) {
      throw new CoordinationError('validation', `${name}[${index}] exceeds ${maxLength} characters`);
    }
    return entry.trim();
  }))];
}

export function integerParam(
  value: unknown,
  name: string,
  options: { optional?: boolean; min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw new CoordinationError('validation', `${name} is required`);
  }
  if (!Number.isInteger(value)) throw new CoordinationError('validation', `${name} must be an integer`);
  const numberValue = value as number;
  if (options.min !== undefined && numberValue < options.min) {
    throw new CoordinationError('validation', `${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    throw new CoordinationError('validation', `${name} must be at most ${options.max}`);
  }
  return numberValue;
}

export function booleanParam(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function isRootMainAgent(ctx: ExecutionContext): boolean {
  const root = SessionManager.getInstance().getRootSession(ctx.sessionId);
  return root.agentId === ctx.agentId;
}
