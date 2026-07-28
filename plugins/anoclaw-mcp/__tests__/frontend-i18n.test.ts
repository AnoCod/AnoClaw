import { describe, expect, it } from 'vitest';
import {
  mcpDictionaries,
  normalizeMcpLocale,
  setMcpLocale,
  t,
} from '../frontend/src/i18n.js';

describe('MCP frontend i18n', () => {
  it('normalizes host locale values', () => {
    expect(normalizeMcpLocale('en')).toBe('en-US');
    expect(normalizeMcpLocale('en-US')).toBe('en-US');
    expect(normalizeMcpLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeMcpLocale('unsupported')).toBe('zh-CN');
  });

  it('keeps English and Chinese dictionaries in parity', () => {
    expect(Object.keys(mcpDictionaries['zh-CN']).sort())
      .toEqual(Object.keys(mcpDictionaries['en-US']).sort());
  });

  it('switches visible MCP labels and preserves interpolation', () => {
    setMcpLocale('en-US');
    expect(t('mcp.title')).toBe('MCP Servers');
    expect(t('mcp.count.connected', { connected: 2, total: 3 })).toBe('2/3 connected');

    setMcpLocale('zh-CN');
    expect(t('mcp.title')).toBe('MCP 服务器');
    expect(t('mcp.count.connected', { connected: 2, total: 3 })).toBe('已连接 2/3');
  });
});
