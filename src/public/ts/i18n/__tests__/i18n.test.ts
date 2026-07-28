import { describe, expect, it } from 'vitest';
import { getLocale, normalizeLocale, setLocale, t } from '../index.js';

describe('frontend i18n', () => {
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

  it('interpolates values in localized strings', () => {
    setLocale('en-US');
    expect(t('taskResolution.subtitle', { capability: 'calendar' })).toBe('"calendar" needs a plugin capability first.');

    setLocale('zh-CN');
    expect(t('taskResolution.subtitle', { capability: '日历' })).toBe('“日历” 需要先准备插件能力。');
  });
});
