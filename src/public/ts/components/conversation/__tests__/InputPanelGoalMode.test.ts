import { describe, expect, it } from 'vitest';
import { goalPermissionModeToUi } from '../types.js';

describe('InputPanel active Goal mode', () => {
  it('uses the Goal contract permission instead of forcing Auto Edit', () => {
    expect(goalPermissionModeToUi('Ask', 'auto-edit')).toBe('ask');
    expect(goalPermissionModeToUi('Plan', 'auto-edit')).toBe('plan');
    expect(goalPermissionModeToUi('Auto', 'auto-edit')).toBe('auto');
  });
});
