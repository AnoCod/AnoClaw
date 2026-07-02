import { describe, it, expect } from 'vitest';
import { makeResult, makeError, toolResultFromJson } from '../ToolResult.js';

describe('ToolResult', () => {
  describe('makeResult', () => {
    it('creates a success result with content', () => {
      const r = makeResult('hello world');
      expect(r.success).toBe(true);
      expect(r.content).toBe('hello world');
      expect(r.errorMessage).toBeUndefined();
      expect(r.toolCallId).toBe('');
      expect(r.wasTruncated).toBe(false);
      expect(r.tokensUsed).toBeGreaterThan(0);
      expect(r.startedAt).toBeGreaterThan(0);
      expect(r.finishedAt).toBeGreaterThan(0);
    });

    it('accepts optional fields', () => {
      const r = makeResult('ok', {
        toolCallId: 'tc-1',
        tokensUsed: 100,
        structured: { count: 42 },
        wasTruncated: true,
      });
      expect(r.toolCallId).toBe('tc-1');
      expect(r.tokensUsed).toBe(100);
      expect(r.structured).toEqual({ count: 42 });
      expect(r.wasTruncated).toBe(true);
    });
  });

  describe('makeError', () => {
    it('creates a failure result with error message', () => {
      const r = makeError('something broke');
      expect(r.success).toBe(false);
      expect(r.errorMessage).toBe('something broke');
      expect(r.content).toBe('');
      expect(r.tokensUsed).toBe(0);
    });

    it('accepts optional fields', () => {
      const r = makeError('broke', { toolCallId: 'tc-2', structured: { code: 500 } });
      expect(r.toolCallId).toBe('tc-2');
      expect(r.structured).toEqual({ code: 500 });
    });
  });

  describe('toolResultFromJson', () => {
    it('parses a success result from JSON', () => {
      const r = toolResultFromJson({
        success: true,
        content: 'result',
        toolCallId: 'tc-3',
        tokensUsed: 50,
      });
      expect(r.success).toBe(true);
      expect(r.content).toBe('result');
      expect(r.toolCallId).toBe('tc-3');
      expect(r.tokensUsed).toBe(50);
    });

    it('parses an error result from JSON', () => {
      const r = toolResultFromJson({
        success: false,
        errorMessage: 'failed',
      });
      expect(r.success).toBe(false);
      expect(r.errorMessage).toBe('failed');
    });

    it('handles missing fields gracefully', () => {
      const r = toolResultFromJson({});
      expect(r.success).toBe(false);
      expect(r.content).toBe('');
      expect(r.toolCallId).toBe('');
      expect(r.tokensUsed).toBe(0);
    });
  });
});
