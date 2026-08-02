import { describe, expect, it } from 'vitest';
import { getLocale, normalizeLocale, onLocaleChange, setLocale, t } from '../index.js';
import { enUS } from '../locales/en-US.js';
import { zhCN } from '../locales/zh-CN.js';

describe('frontend i18n', () => {
  it('keeps the English and Chinese dictionaries in exact key parity', () => {
    const enKeys = Object.keys(enUS).sort();
    const zhKeys = Object.keys(zhCN).sort();

    expect(enKeys).toEqual(zhKeys);
    expect(enKeys.length).toBeGreaterThan(0);
    expect(Object.values(enUS).every((value) => value.trim().length > 0)).toBe(true);
    expect(Object.values(zhCN).every((value) => value.trim().length > 0)).toBe(true);
  });

  it('keeps interpolation placeholders aligned across locales', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
        .map((match) => match[1])
        .sort();

    for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
      expect(placeholders(enUS[key]), key).toEqual(placeholders(zhCN[key]));
    }
  });

  it('normalizes legacy and regional locale codes', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('en')).toBe('en-US');
    expect(normalizeLocale('en-US')).toBe('en-US');
    expect(normalizeLocale('unknown')).toBe('zh-CN');
  });

  it('switches the active locale and translates settings labels', () => {
    setLocale('en-US');
    expect(getLocale()).toBe('en-US');
    expect(t('settings.save')).toBe('Save Settings');

    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(t('settings.save')).toBe('保存设置');
  });

  it('notifies locale subscribers once per actual change and supports cleanup', () => {
    setLocale('zh-CN');
    const changes: Array<{ locale: string; previousLocale: string }> = [];
    const unsubscribe = onLocaleChange((change) => changes.push(change));

    setLocale('en-US');
    setLocale('en');

    expect(changes).toEqual([
      { locale: 'en-US', previousLocale: 'zh-CN' },
    ]);

    unsubscribe();
    unsubscribe();
    setLocale('zh-CN');
    expect(changes).toHaveLength(1);
  });

  it('interpolates values in localized strings', () => {
    setLocale('en-US');
    expect(t('taskResolution.subtitle', { capability: 'calendar' })).toBe('"calendar" needs a plugin capability first.');

    setLocale('zh-CN');
    expect(t('taskResolution.subtitle', { capability: '日历' })).toBe('“日历” 需要先准备插件能力。');
  });
});
