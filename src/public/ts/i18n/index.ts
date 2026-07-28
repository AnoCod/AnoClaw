import { enUS } from './locales/en-US.js';
import { zhCN } from './locales/zh-CN.js';

export type LocaleCode = 'zh-CN' | 'en-US';
export type TranslationKey = keyof typeof zhCN;

export interface LocaleOption {
  code: LocaleCode;
  label: string;
  nativeName: string;
}

export interface LocaleChange {
  locale: LocaleCode;
  previousLocale: LocaleCode;
}

type TranslationParams = Record<string, string | number | boolean | null | undefined>;
type LocaleChangeListener = (change: LocaleChange) => void;

const dictionaries: Record<LocaleCode, Record<TranslationKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: 'zh-CN', label: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'en-US', label: 'English (US)', nativeName: 'English' },
];

let currentLocale: LocaleCode = 'zh-CN';
const localeChangeListeners = new Set<LocaleChangeListener>();

export function normalizeLocale(value: unknown): LocaleCode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'en' || raw === 'en-us') return 'en-US';
  if (raw === 'zh' || raw === 'zh-cn' || raw === 'zh-hans' || raw === 'cn') return 'zh-CN';
  return 'zh-CN';
}

export function setLocale(locale: unknown): LocaleCode {
  const nextLocale = normalizeLocale(locale);
  if (nextLocale === currentLocale) return currentLocale;

  const previousLocale = currentLocale;
  currentLocale = nextLocale;
  const change = { locale: currentLocale, previousLocale };
  for (const listener of [...localeChangeListeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('[i18n] Locale change listener failed', error);
    }
  }
  return currentLocale;
}

export function getLocale(): LocaleCode {
  return currentLocale;
}

/**
 * Subscribe to runtime locale changes.
 *
 * Listeners run synchronously after the active dictionary changes, so UI
 * components can rebuild before the next browser paint. The returned cleanup
 * callback is idempotent and should be called when a short-lived component is
 * disposed.
 */
export function onLocaleChange(listener: LocaleChangeListener): () => void {
  localeChangeListeners.add(listener);
  return () => {
    localeChangeListeners.delete(listener);
  };
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

/**
 * Refresh declaratively localized DOM nodes without rebuilding their parent
 * component. Optional `data-i18n-params` contains a JSON object and
 * `data-i18n-attr` targets an attribute instead of textContent.
 */
export function refreshLocalizedElements(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n-key]').forEach((element) => {
    const key = element.dataset.i18nKey as TranslationKey | undefined;
    if (!key) return;
    let params: TranslationParams = {};
    if (element.dataset.i18nParams) {
      try {
        params = JSON.parse(element.dataset.i18nParams) as TranslationParams;
      } catch {
        params = {};
      }
    }
    const value = t(key, params);
    const attr = element.dataset.i18nAttr;
    if (attr) element.setAttribute(attr, value);
    else element.textContent = value;
  });
}
