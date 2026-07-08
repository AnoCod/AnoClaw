import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTIONS,
  BrowserAgentTool,
  buildDomSnapshotScript,
  buildFindElementsScript,
  normalizeBrowserWaitMs,
} from '../builtin/BrowserAgentTool.js';

describe('BrowserAgentTool', () => {
  it('exposes observation and advanced interaction actions in the schema', () => {
    const tool = new BrowserAgentTool();
    const schema = tool.parametersSchema() as {
      properties: {
        action: { enum: readonly string[] };
        selector: { description: string };
        event_type: { type: string };
        key: { type: string };
        max_items: { type: string; minimum: number; maximum: number };
        scroll_amount: { type: string; minimum: number; maximum: number };
        wait_ms: { type: string; minimum: number; maximum: number };
      };
    };

    expect(schema.properties.action.enum).toEqual(BROWSER_ACTIONS);
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining([
      'inspect',
      'find',
      'hover',
      'select',
      'press',
      'dispatch_event',
    ]));
    expect(schema.properties.selector.description).toContain('inspect');
    expect(schema.properties.event_type.type).toBe('string');
    expect(schema.properties.key.type).toBe('string');
    expect(schema.properties.max_items).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
    expect(schema.properties.scroll_amount).toMatchObject({ type: 'integer', minimum: -50000, maximum: 50000 });
    expect(schema.properties.wait_ms).toMatchObject({ type: 'integer', minimum: 1, maximum: 30000 });
  });

  it('teaches agents to inspect and find elements before guessing selectors', () => {
    const prompt = new BrowserAgentTool().description();

    expect(prompt).toContain('inspect(selector?)');
    expect(prompt).toContain('find(value)');
    expect(prompt).toContain('Use this before guessing selectors');
  });

  it('builds a DOM snapshot script with selector scoping and bounded output', () => {
    const script = buildDomSnapshotScript('#login', 999);

    expect(script).toContain('const rootSelector = "#login"');
    expect(script).toContain('const maxItems = 200');
    expect(script).toContain('headings');
    expect(script).toContain('interactive');
    expect(script).toContain('forms');
    expect(script).toContain('scroll');
  });

  it('builds a text finder script with escaped query and bounded output', () => {
    const script = buildFindElementsScript('Sign in "now"', 999);

    expect(script).toContain('const needle = "Sign in \\"now\\"".toLowerCase()');
    expect(script).toContain('const maxItems = 100');
    expect(script).toContain('matches');
    expect(script).toContain('selectorFor');
  });

  it('normalizes browser wait durations to the declared bounded range', () => {
    expect(normalizeBrowserWaitMs(undefined)).toBe(1000);
    expect(normalizeBrowserWaitMs(1)).toBe(1);
    expect(normalizeBrowserWaitMs(30000)).toBe(30000);
    expect(() => normalizeBrowserWaitMs(0)).toThrow('wait_ms must be between 1 and 30000');
    expect(() => normalizeBrowserWaitMs(30001)).toThrow('wait_ms must be between 1 and 30000');
    expect(() => normalizeBrowserWaitMs(1.5)).toThrow('wait_ms must be an integer');
    expect(() => normalizeBrowserWaitMs('1000')).toThrow('wait_ms must be an integer');
  });
});
