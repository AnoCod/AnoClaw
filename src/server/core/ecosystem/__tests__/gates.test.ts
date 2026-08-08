import { describe, expect, it } from 'vitest';
import { evaluateSkillGates } from '../gates.js';

describe('evaluateSkillGates', () => {
  it('accepts skills without ecosystem gates', () => {
    expect(evaluateSkillGates('claude', { name: 'x', description: 'y' })).toEqual({ ok: true, reasons: [] });
  });

  it('enforces OpenClaw requires.env', () => {
    const fm = {
      name: 'x',
      description: 'y',
      metadata: {
        openclaw: {
          requires: { env: ['GEMINI_API_KEY'] },
        },
      },
    };
    expect(evaluateSkillGates('openclaw', fm, { env: { GEMINI_API_KEY: 'k' } }).ok).toBe(true);
    const missing = evaluateSkillGates('openclaw', fm, { env: {} });
    expect(missing.ok).toBe(false);
    expect(missing.reasons.join()).toContain('GEMINI_API_KEY');
  });

  it('honors metadata.openclaw.always', () => {
    const fm = {
      name: 'x',
      description: 'y',
      metadata: {
        openclaw: {
          always: true,
          requires: { env: ['MISSING'] },
        },
      },
    };
    expect(evaluateSkillGates('openclaw', fm, { env: {} }).ok).toBe(true);
  });

  it('enforces Hermes platforms', () => {
    const fm = { name: 'x', description: 'y', platforms: ['macos', 'linux'] };
    expect(evaluateSkillGates('hermes', fm, { platform: 'darwin' }).ok).toBe(true);
    const win = evaluateSkillGates('hermes', fm, { platform: 'win32' });
    expect(win.ok).toBe(false);
    expect(win.reasons.join()).toContain('macos');
  });

  it('enforces Hermes requires_tools against available tools', () => {
    const fm = {
      name: 'x',
      description: 'y',
      metadata: { hermes: { requires_tools: ['web_search'] } },
    };
    expect(evaluateSkillGates('hermes', fm, { tools: new Set(['web_search']) }).ok).toBe(true);
    expect(evaluateSkillGates('hermes', fm, { tools: new Set([]) }).ok).toBe(false);
  });
});
