import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolvePlaceholders, substituteSkillPathVars, expandHome } from '../placeholders.js';

describe('resolvePlaceholders', () => {
  it('resolves ${env:X}, ${X} and {env:X} forms', () => {
    const env = { TOKEN: 'abc', EMPTY: '' };
    const result = resolvePlaceholders({
      a: '${env:TOKEN}',
      b: '${TOKEN}',
      c: '{env:TOKEN}',
      d: 'prefix-${env:TOKEN}-suffix',
    }, { env });
    expect(result.value).toEqual({
      a: 'abc',
      b: 'abc',
      c: 'abc',
      d: 'prefix-abc-suffix',
    });
    expect(result.unresolved).toEqual([]);
  });

  it('keeps missing placeholders literal and reports them', () => {
    const result = resolvePlaceholders('${env:MISSING_VAR}', { env: {} });
    expect(result.value).toBe('${env:MISSING_VAR}');
    expect(result.unresolved).toEqual(['MISSING_VAR']);
  });

  it('resolves Cursor-style context variables', () => {
    const result = resolvePlaceholders('${userHome}|${workspaceFolder}|${pathSeparator}', {
      env: {},
      userHome: 'C:\\Users\\me',
      workspaceFolder: 'C:\\repo\\sub',
    });
    expect(result.value).toBe('C:\\Users\\me|C:\\repo\\sub|\\');
  });

  it('walks arrays and nested objects', () => {
    const result = resolvePlaceholders(
      { arr: ['${env:ONE}', { two: '${env:TWO}' }] },
      { env: { ONE: '1', TWO: '2' } },
    );
    expect(result.value).toEqual({ arr: ['1', { two: '2' }] });
  });
});

describe('substituteSkillPathVars', () => {
  it('substitutes Claude and OpenClaw path variables', () => {
    const out = substituteSkillPathVars(
      'read ${CLAUDE_SKILL_DIR}/x and {baseDir}/y and ${PLUGIN_ROOT}/z',
      { skillDir: '/s', pluginRoot: '/p' },
    );
    expect(out).toBe('read /s/x and /s/y and /p/z');
  });
});

describe('expandHome', () => {
  it('expands leading tilde paths', () => {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (!home) return;
    expect(expandHome('~/x/y')).toBe(path.join(home, 'x', 'y'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
});
