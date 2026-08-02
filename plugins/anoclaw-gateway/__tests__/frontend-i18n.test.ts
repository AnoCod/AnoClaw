import { describe, expect, it } from 'vitest';
import {
  normalizePluginLocale,
  pluginDictionaries,
  setPluginLocale,
  t,
} from '../frontend/src/i18n.js';

describe('gateway frontend i18n', () => {
  it('normalizes host locale values', () => {
    expect(normalizePluginLocale('en')).toBe('en-US');
    expect(normalizePluginLocale('en-US')).toBe('en-US');
    expect(normalizePluginLocale('zh-CN')).toBe('zh-CN');
    expect(normalizePluginLocale('unsupported')).toBe('zh-CN');
  });

  it('keeps the English and Chinese dictionaries in parity', () => {
    expect(Object.keys(pluginDictionaries['zh-CN']).sort())
      .toEqual(Object.keys(pluginDictionaries['en-US']).sort());
  });

  it('switches visible Gateway labels and interpolates values', () => {
    setPluginLocale('en-US');
    expect(t('gateway.platforms')).toBe('Platforms');
    expect(t('gateway.inbox.count.many', { count: 3 })).toBe('3 messages');

    setPluginLocale('zh-CN');
    expect(t('gateway.platforms')).toBe('平台');
    expect(t('gateway.inbox.count.many', { count: 3 })).toBe('3 条消息');
  });
});
