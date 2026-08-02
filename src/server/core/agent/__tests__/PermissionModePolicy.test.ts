import { describe, expect, it } from 'vitest';
import {
  goalContinuationPermissionMode,
  hasActiveSessionGoal,
  normalizePermissionMode,
  parsePermissionMode,
  permissionModeToUi,
  resolveSessionPermissionMode,
  toolRequiresConfirmation,
} from '../PermissionModePolicy.js';
import type { SessionManager } from '../../session/SessionManager.js';
import { RiskLevel } from '../../../../shared/types/tool.js';
import type { PermissionMode } from '../../../../shared/types/session.js';

const permissionModes: PermissionMode[] = ['Ask', 'AutoEdit', 'Auto', 'Plan'];
const riskLevels = [
  RiskLevel.Safe,
  RiskLevel.Low,
  RiskLevel.Medium,
  RiskLevel.High,
  RiskLevel.Critical,
];
const confirmationTruthTable = permissionModes.flatMap(mode =>
  [false, true].flatMap(readOnly =>
    riskLevels.map(risk => ({
      mode,
      readOnly,
      risk,
      expected: readOnly
        ? false
        : mode === 'Ask'
          ? true
          : mode === 'Auto'
            ? risk === RiskLevel.High || risk === RiskLevel.Critical
            : false,
    })),
  ),
);

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

  it('pins every Goal continuation to Auto Edit', () => {
    expect(goalContinuationPermissionMode()).toBe('AutoEdit');
    expect(goalContinuationPermissionMode('AutoEdit')).toBe('AutoEdit');
    expect(goalContinuationPermissionMode('Ask')).toBe('AutoEdit');
    expect(goalContinuationPermissionMode('Plan')).toBe('AutoEdit');
  });

  it('promotes every active Goal to Auto Edit without changing stored session mode', () => {
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
    expect(resolveSessionPermissionMode(sessionManager, 'session-1', 'ask')).toBe('AutoEdit');
    expect(resolveSessionPermissionMode(sessionManager, 'session-1', 'plan')).toBe('AutoEdit');
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

  it('pins sub-sessions to Auto Edit', () => {
    const sessionManager = {
      session: () => ({ isRoot: () => false, metadata: { permissionMode: 'Plan' } }),
      getGoal: () => null,
    } as unknown as SessionManager;

    expect(resolveSessionPermissionMode(sessionManager, 'child-session', 'ask')).toBe('AutoEdit');
  });

  it.each(confirmationTruthTable)(
    '$mode mode confirmation policy for readOnly=$readOnly risk=$risk is $expected',
    ({ mode, readOnly, risk, expected }) => {
      expect(toolRequiresConfirmation(mode, {
        isReadOnly: () => readOnly,
        riskLevel: () => risk,
      })).toBe(expected);
    },
  );
});
