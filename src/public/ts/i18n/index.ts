import { enUS } from './locales/en-US.js';
import { zhCN } from './locales/zh-CN.js';

export type LocaleCode = 'zh-CN' | 'en-US';
export type TranslationKey = keyof typeof zhCN;

export interface LocaleOption {
  code: LocaleCode;
  label: string;
  nativeName: string;
}

type TranslationParams = Record<string, string | number | boolean | null | undefined>;

const dictionaries: Record<LocaleCode, Record<TranslationKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: 'zh-CN', label: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'en-US', label: 'English (US)', nativeName: 'English' },
];

let currentLocale: LocaleCode = 'zh-CN';

export function normalizeLocale(value: unknown): LocaleCode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'en' || raw === 'en-us') return 'en-US';
  if (raw === 'zh' || raw === 'zh-cn' || raw === 'zh-hans' || raw === 'cn') return 'zh-CN';
  return 'zh-CN';
}

export function setLocale(locale: unknown): LocaleCode {
  currentLocale = normalizeLocale(locale);
  return currentLocale;
}

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function localeDirection(_locale: LocaleCode): 'ltr' {
  return 'ltr';
}

export function t(key: TranslationKey, params: TranslationParams = {}, locale = currentLocale): string {
  const resolvedLocale = normalizeLocale(locale);
  const template = dictionaries[resolvedLocale][key] || dictionaries['zh-CN'][key] || key;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
