import { describe, expect, it } from 'vitest';
import {
  normalizePermissionMode,
  parsePermissionMode,
  permissionModeToUi,
} from '../PermissionModePolicy.js';

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
});
