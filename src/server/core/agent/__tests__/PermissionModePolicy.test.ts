import { describe, expect, it } from 'vitest';
import {
  goalContinuationPermissionMode,
  hasActiveSessionGoal,
  normalizePermissionMode,
  parsePermissionMode,
  permissionModeToUi,
  resolveSessionPermissionMode,
} from '../PermissionModePolicy.js';
import type { SessionManager } from '../../session/SessionManager.js';

describe('PermissionModePolicy', () => {
  it('normalizes UI, API, and legacy mode spellings', () => {
    expect(normalizePermissionMode('ask')).toBe('Ask');
    expect(normalizePermissionMode('AutoEdit')).toBe('AutoEdit');
    expect(normalizePermissionMode('auto-edit')).toBe('AutoEdit');
    expect(normalizePermissionMode('auto_edit')).toBe('AutoEdit');
    expect(normalizePermissionMode('plan')).toBe('Plan');
    expect(normalizePermissionMode('auto')).toBe('Auto');
  });

  it('parses unknown values as undefined without changing the fallback path', () => {
    expect(parsePermissionMode('auto_edit')).toBe('AutoEdit');
    expect(parsePermissionMode('unknown')).toBeUndefined();
    expect(normalizePermissionMode('unknown', 'Ask')).toBe('Ask');
  });

  it('serializes canonical modes back to UI mode names', () => {
    expect(permissionModeToUi('Ask')).toBe('ask');
    expect(permissionModeToUi('AutoEdit')).toBe('auto-edit');
    expect(permissionModeToUi('Plan')).toBe('plan');
    expect(permissionModeToUi('Auto')).toBe('auto');
  });

  it('uses Safe Auto by default and honors an explicit Goal contract mode', () => {
    expect(goalContinuationPermissionMode()).toBe('Auto');
    expect(goalContinuationPermissionMode('AutoEdit')).toBe('AutoEdit');
  });

  it('uses the active Goal contract instead of silently promoting permissions', () => {
    const sessionManager = {
      session: () => ({ isRoot: () => true, metadata: { permissionMode: 'Ask' } }),
      getGoal: () => ({
        objective: 'keep working',
        permissionMode: 'Ask',
        status: 'active',
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      }),
    } as unknown as SessionManager;

    expect(hasActiveSessionGoal(sessionManager, 'session-1')).toBe(true);
    expect(resolveSessionPermissionMode(sessionManager, 'session-1', 'auto-edit')).toBe('Ask');
    expect(resolveSessionPermissionMode(sessionManager, 'session-1', 'plan')).toBe('Ask');
  });

  it('keeps paused goals on the requested or stored permission mode', () => {
    const sessionManager = {
      session: () => ({ isRoot: () => true, metadata: { permissionMode: 'Auto' } }),
      getGoal: () => ({
        objective: 'keep working',
        status: 'paused',
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      }),
    } as unknown as SessionManager;

    expect(hasActiveSessionGoal(sessionManager, 'session-1')).toBe(false);
    expect(resolveSessionPermissionMode(sessionManager, 'session-1', 'ask')).toBe('Ask');
    expect(resolveSessionPermissionMode(sessionManager, 'session-1')).toBe('Auto');
  });
});
