import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import type { SessionManager } from '../session/SessionManager.js';

export type PermissionMode = 'Ask' | 'AutoEdit' | 'Plan' | 'Auto';

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

export function defaultPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(SettingsManager.getInstance().get<string>('ui.permissionMode', 'Auto'));
  } catch {
    return 'Auto';
  }
}

export function activeGoalPermissionMode(): PermissionMode {
  return 'AutoEdit';
}

export function goalContinuationPermissionMode(): PermissionMode {
  // Goal wakeups run without a waiting user, so avoid confirmation dialogs
  // pausing autonomous progress.
  return activeGoalPermissionMode();
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
  if (!session.isRoot()) return 'AutoEdit';
  if (hasActiveSessionGoal(sessionManager, sessionId)) return activeGoalPermissionMode();

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
