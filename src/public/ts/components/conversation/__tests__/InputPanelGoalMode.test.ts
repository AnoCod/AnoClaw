import { describe, expect, it } from 'vitest';
import { goalPermissionModeToUi } from '../types.js';

describe('InputPanel active Goal mode', () => {
  it('forces every Goal contract to Auto Edit, including legacy values', () => {
    expect(goalPermissionModeToUi('Ask', 'ask')).toBe('auto-edit');
    expect(goalPermissionModeToUi('Plan', 'plan')).toBe('auto-edit');
    expect(goalPermissionModeToUi('Auto', 'auto')).toBe('auto-edit');
  });
});
