import type { UserMode } from './types.js';
import type { TranslationKey } from './i18n/index.js';

export interface UserModeOption {
  value: UserMode;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}

export const USER_MODE_OPTIONS: UserModeOption[] = [
  {
    value: 'simple',
    labelKey: 'settings.userMode.simple',
    descriptionKey: 'settings.userMode.simpleDesc',
  },
  {
    value: 'office',
    labelKey: 'settings.userMode.office',
    descriptionKey: 'settings.userMode.officeDesc',
  },
  {
    value: 'child',
    labelKey: 'settings.userMode.child',
    descriptionKey: 'settings.userMode.childDesc',
  },
  {
    value: 'professional',
    labelKey: 'settings.userMode.professional',
    descriptionKey: 'settings.userMode.professionalDesc',
  },
];

export function normalizeUserMode(value: unknown): UserMode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'office' || raw === 'work') return 'office';
  if (raw === 'child' || raw === 'kids' || raw === 'education') return 'child';
  if (raw === 'professional' || raw === 'pro' || raw === 'expert') return 'professional';
  return 'simple';
}
