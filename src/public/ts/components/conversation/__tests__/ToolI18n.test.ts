import { afterEach, describe, expect, it } from 'vitest';
import { refreshLocalizedElements, setLocale, t } from '../../../i18n/index.js';
import { TOOL_REGISTRY } from '../delegates/ToolRegistry.js';
import { generateToolResultSummaryDescriptor } from '../delegates/ToolResultSummary.js';

afterEach(() => setLocale('zh-CN'));

describe('tool presentation i18n', () => {
  it('keeps generated summaries as translation descriptors for live refresh', () => {
    setLocale('en-US');
    const summary = generateToolResultSummaryDescriptor({
      type: 'tool_result',
      toolName: 'Grep',
      content: 'a.ts:1:first\nb.ts:2:second',
    });

    expect(summary.key).toBe('message.tool.summary.matchesAcrossFiles');
    expect(summary.params).toEqual({ matches: 2, files: 2 });
    expect(summary.text).toBe('Found 2 matches across 2 files');

    setLocale('zh-CN');
    expect(t(summary.key!, summary.params)).toBe('在 2 个文件中找到 2 个匹配项');

    const element = {
      dataset: {
        i18nKey: summary.key,
        i18nParams: JSON.stringify(summary.params),
      },
      textContent: summary.text,
      setAttribute: () => {},
    };
    const existingCard = {
      querySelectorAll: () => [element],
    } as unknown as ParentNode;
    refreshLocalizedElements(existingCard);
    expect(element.textContent).toBe('在 2 个文件中找到 2 个匹配项');
  });

  it('localizes frontend-authored registry results without changing tool output', () => {
    const state = {
      toolName: 'Glob',
      toolInput: {},
      status: 'success' as const,
      result: 'src/a.ts\nsrc/b.ts',
    };

    setLocale('en-US');
    expect(TOOL_REGISTRY.Glob.result(state)).toBe('2 files');

    setLocale('zh-CN');
    expect(TOOL_REGISTRY.Glob.result(state)).toBe('2 个文件');
  });

  it('leaves verbatim short command output untouched', () => {
    setLocale('zh-CN');
    const summary = generateToolResultSummaryDescriptor({
      type: 'tool_result',
      toolName: 'Bash',
      content: 'v2.4.1',
    });

    expect(summary).toEqual({ text: 'v2.4.1' });
  });
});
