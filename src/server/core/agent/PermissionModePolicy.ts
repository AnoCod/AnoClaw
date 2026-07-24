import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import type { RiskLevel } from '../../../shared/types/tool.js';
import type {
  PermissionMode,
  ToolExecutionMode,
} from '../../../shared/types/session.js';
import type { SessionManager } from '../session/SessionManager.js';

export type { PermissionMode, ToolExecutionMode } from '../../../shared/types/session.js';

export const FULL_AUTO_PERMISSION_MODE: PermissionMode = 'AutoEdit';

export interface ToolPermissionSubject {
  isReadOnly(): boolean;
  riskLevel(): RiskLevel | string;
}

function parsePermissionModeValue(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase().replace(/_/g, '-');
  switch (key) {
    case 'ask':
      return 'Ask';
    case 'autoedit':
    case 'auto-edit':
      return 'AutoEdit';
    case 'plan':
      return 'Plan';
    case 'auto':
      return 'Auto';
    default:
      return undefined;
  }
}

export function normalizePermissionMode(value: unknown, fallback: PermissionMode = 'Auto'): PermissionMode {
  return parsePermissionModeValue(value) || fallback;
}

export function parsePermissionMode(value: unknown): PermissionMode | undefined {
  return parsePermissionModeValue(value);
}

export function permissionModeToUi(mode: PermissionMode): 'ask' | 'auto-edit' | 'plan' | 'auto' {
  switch (mode) {
    case 'Ask': return 'ask';
    case 'AutoEdit': return 'auto-edit';
    case 'Plan': return 'plan';
    case 'Auto':
    default:
      return 'auto';
  }
}

export function permissionModeToExecutionMode(mode: PermissionMode): ToolExecutionMode {
  switch (mode) {
    case 'Ask': return 'ask';
    case 'AutoEdit': return 'auto_edit';
    case 'Plan': return 'read_only';
    case 'Auto':
    default:
      return 'auto';
  }
}

export function executionModeToPermissionMode(mode: unknown): PermissionMode | undefined {
  if (typeof mode !== 'string') return undefined;
  const key = mode.trim().toLowerCase().replace(/-/g, '_');
  switch (key) {
    case 'ask': return 'Ask';
    case 'auto_edit':
    case 'autoedit':
      return 'AutoEdit';
    case 'read_only':
    case 'readonly':
    case 'plan':
      return 'Plan';
    case 'auto':
      return 'Auto';
    default:
      return undefined;
  }
}

export function isAutoApprovedExecutionMode(mode: unknown): boolean {
  return executionModeToPermissionMode(mode) === FULL_AUTO_PERMISSION_MODE;
}

/**
 * Single confirmation truth table for session-driven tool calls.
 * Plan-mode mutations are blocked by ToolPipeline instead of prompting.
 */
export function toolRequiresConfirmation(
  mode: PermissionMode,
  tool: ToolPermissionSubject,
): boolean {
  if (tool.isReadOnly()) return false;
  switch (mode) {
    case 'Ask':
      return true;
    case 'AutoEdit':
    case 'Plan':
      return false;
    case 'Auto': {
      const risk = String(tool.riskLevel());
      return risk === 'High' || risk === 'Critical';
    }
    default:
      return true;
  }
}

export function defaultPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(SettingsManager.getInstance().get<string>('ui.permissionMode', 'Auto'));
  } catch {
    return 'Auto';
  }
}

export function activeGoalPermissionMode(_value?: unknown): PermissionMode {
  return FULL_AUTO_PERMISSION_MODE;
}

export function goalContinuationPermissionMode(value?: unknown): PermissionMode {
  return activeGoalPermissionMode(value);
}

export function hasActiveSessionGoal(sessionManager: SessionManager, sessionId: string): boolean {
  try {
    return sessionManager.getGoal(sessionId)?.status === 'active';
  } catch {
    return false;
  }
}

export function resolveSessionPermissionMode(
  sessionManager: SessionManager,
  sessionId: string,
  requested?: unknown,
): PermissionMode {
  const session = sessionManager.session(sessionId);
  if (!session) return normalizePermissionMode(requested, defaultPermissionMode());
  if (!session.isRoot()) return FULL_AUTO_PERMISSION_MODE;
  const goal = sessionManager.getGoal(sessionId);
  if (goal?.status === 'active') return FULL_AUTO_PERMISSION_MODE;

  const requestedMode = parsePermissionMode(requested);
  if (requestedMode) return requestedMode;

  const metadataMode = session.metadata.permissionMode;
  return normalizePermissionMode(metadataMode, defaultPermissionMode());
}

export function resolveSessionEffort(
  sessionManager: SessionManager,
  sessionId: string,
  requested?: unknown,
): 'HIGH' | 'NORMAL' {
  const session = sessionManager.session(sessionId);
  if (session && !session.isRoot()) return 'HIGH';
  if (typeof requested === 'boolean') return requested ? 'HIGH' : 'NORMAL';
  if (session?.metadata.effortMode === false) return 'NORMAL';
  return 'HIGH';
}
