import { describe, it, expect, vi } from 'vitest';
import { ToolPipeline } from '../ToolPipeline.js';
import { RiskLevel } from '../../../../shared/types/tool.js';
import type { Tool } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { makeResult, makeError } from '../ToolResult.js';

// ── Helpers ──

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    workspace: '/tmp',
    userConfirmed: false,
    ...overrides,
  };
}

function mockTool(overrides: Record<string, unknown> = {}): Tool {
  return {
    name: () => (overrides.name as string) ?? 'TestTool',
    description: () => 'A test tool',
    parametersSchema: () => (overrides.parametersSchema as Record<string, unknown>) ?? {},
    riskLevel: () => (overrides.riskLevel as RiskLevel) ?? RiskLevel.Low,
    isReadOnly: () => (overrides.isReadOnly as boolean) ?? true,
    workspacePathParams: () => (overrides.workspacePathParams as string[]) ?? [],
    maxRetries: () => (overrides.maxRetries as number) ?? 3,
    outputLimit: () => (overrides.outputLimit as number) ?? 10000,
    _executeWithEvents: vi.fn().mockResolvedValue(makeResult('ok')),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as Tool;
}

// ── Stage 0: validateParams ──

describe('ToolPipeline.validateParams', () => {
  it('returns null when no schema is defined', () => {
    const tool = mockTool({ parametersSchema: undefined });
    expect(ToolPipeline.validateParams(tool, { x: 1 })).toBeNull();
  });

  it('returns error for missing required param', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['filePath'],
        properties: { filePath: { type: 'string' } },
      },
    });
    const r = ToolPipeline.validateParams(tool, {});
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.errorMessage).toContain('filePath');
  });

  it('returns error for wrong type', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'number' } },
      },
    });
    const r = ToolPipeline.validateParams(tool, { count: 'not-a-number' });
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('count');
  });

  it('returns error for value not in enum', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['a', 'b'] } },
      },
    });
    const r = ToolPipeline.validateParams(tool, { mode: 'c' });
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('mode');
  });

  it('returns null for valid params', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    });
    expect(ToolPipeline.validateParams(tool, { path: '/tmp' })).toBeNull();
  });

  it('skips validation for optional missing fields', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: [],
        properties: { optional: { type: 'string' } },
      },
    });
    expect(ToolPipeline.validateParams(tool, {})).toBeNull();
  });

  it('validates type for array values', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array' } },
      },
    });
    expect(ToolPipeline.validateParams(tool, { items: 'not-array' })).not.toBeNull();
    expect(ToolPipeline.validateParams(tool, { items: [1, 2] })).toBeNull();
  });
});

// ── Stage 1: securityCheck ──

describe('ToolPipeline.securityCheck', () => {
  it('blocks critical tools without user confirmation', () => {
    const tool = mockTool({ riskLevel: RiskLevel.Critical });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: false }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('confirmation');
  });

  it('allows critical tools with user confirmation', () => {
    const tool = mockTool({ riskLevel: RiskLevel.Critical });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: true }))).toBeNull();
  });

  it('allows low-risk tools without confirmation', () => {
    const tool = mockTool({ riskLevel: RiskLevel.Low });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: false }))).toBeNull();
  });

  it('blocks non-read-only tools in read_only mode', () => {
    const tool = mockTool({ isReadOnly: false });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'read_only' } as unknown as ExecutionContext));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('read_only');
  });

  it('allows read-only tools in read_only mode', () => {
    const tool = mockTool({ isReadOnly: true });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'read_only' } as unknown as ExecutionContext))).toBeNull();
  });

  // ── Workspace boundary ──

  it('blocks absolute path outside workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    const r = ToolPipeline.securityCheck(tool, { file_path: '/etc/passwd' }, ctx({ workspace: '/home/user/project' }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('Path boundary violation');
  });

  it('blocks ../ traversal that escapes workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    const r = ToolPipeline.securityCheck(tool, { file_path: '../../etc/passwd' }, ctx({ workspace: '/home/user/project' }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('Path boundary violation');
  });

  it('allows absolute path inside workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    expect(ToolPipeline.securityCheck(tool, { file_path: '/home/user/project/src/index.ts' }, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('allows relative path that stays inside workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    expect(ToolPipeline.securityCheck(tool, { file_path: 'src/index.ts' }, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('allows path equal to workspace itself', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    expect(ToolPipeline.securityCheck(tool, { file_path: '/home/user/project' }, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('skips if tool has no workspacePathParams', () => {
    const tool = mockTool({ workspacePathParams: [] });
    expect(ToolPipeline.securityCheck(tool, { file_path: '/etc/passwd' }, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('skips if ctx has no workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    expect(ToolPipeline.securityCheck(tool, { file_path: '/etc/passwd' }, ctx({ workspace: '' }))).toBeNull();
  });

  it('skips empty path value (optional param not provided)', () => {
    const tool = mockTool({ workspacePathParams: ['path'] });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('blocks Windows absolute path outside workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    const r = ToolPipeline.securityCheck(tool, { file_path: 'D:\\windows\\system32' }, ctx({ workspace: 'C:\\Users\\dev\\project' }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('Path boundary violation');
  });

  it('allows Windows path inside workspace', () => {
    const tool = mockTool({ workspacePathParams: ['file_path'] });
    expect(ToolPipeline.securityCheck(tool, { file_path: 'C:\\Users\\dev\\project\\src\\index.ts' }, ctx({ workspace: 'C:\\Users\\dev\\project' }))).toBeNull();
  });

  it('handles multiple path params', () => {
    const tool = mockTool({ workspacePathParams: ['notebook_path'] });
    expect(ToolPipeline.securityCheck(tool, { notebook_path: '/home/user/project/notebook.ipynb', new_source: 'print("hi")' }, ctx({ workspace: '/home/user/project' }))).toBeNull();
  });

  it('blocks non-read-only tools in readOnly mode', () => {
    const tool = mockTool({ isReadOnly: false });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'readOnly' } as unknown as ExecutionContext));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('readOnly');
  });
});

// ── Stage 3: retry classification ──

describe('ToolPipeline.retry error classification', () => {
  it('retries on ECONNRESET / network errors', async () => {
    const tool = mockTool({
      maxRetries: 2,
      _executeWithEvents: vi.fn()
        .mockResolvedValueOnce(makeError('ECONNRESET: connection lost'))
        .mockResolvedValueOnce(makeResult('ok')),
    });
    const orig = makeError('ECONNRESET: connection lost');
    const r = await ToolPipeline.retry(tool, {}, ctx(), orig);
    expect(r.success).toBe(true);
  });

  it('retries on rate limit errors', async () => {
    const tool = mockTool({
      maxRetries: 2,
      _executeWithEvents: vi.fn()
        .mockResolvedValueOnce(makeError('Rate limit exceeded'))
        .mockResolvedValueOnce(makeResult('ok')),
    });
    const orig = makeError('Rate limit exceeded');
    const r = await ToolPipeline.retry(tool, {}, ctx(), orig);
    expect(r.success).toBe(true);
  });

  it('does NOT retry user-visible errors like ENOENT', async () => {
    const tool = mockTool({
      maxRetries: 2,
      _executeWithEvents: vi.fn(),
    });
    const orig = makeError('ENOENT: no such file');
    const r = await ToolPipeline.retry(tool, {}, ctx(), orig);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('ENOENT');
  });

  it('does NOT retry when tool has maxRetries=0', async () => {
    const tool = mockTool({
      maxRetries: 0,
      _executeWithEvents: vi.fn(),
    });
    const orig = makeError('Network error');
    const r = await ToolPipeline.retry(tool, {}, ctx(), orig);
    expect(r.success).toBe(false);
  });

  it('does not retry if original error message is empty', async () => {
    const tool = mockTool({ _executeWithEvents: vi.fn() });
    const orig = makeResult('ok'); // success, no error
    const r = await ToolPipeline.retry(tool, {}, ctx(), orig);
    expect(r.success).toBe(true);
  });
});

// ── Stage 4: normalizeOutput ──

describe('ToolPipeline.normalizeOutput', () => {
  it('passes through content under the limit', () => {
    const tool = mockTool({ outputLimit: 1000 });
    const r = ToolPipeline.normalizeOutput(makeResult('short'), tool);
    expect(r.content).toBe('short');
    expect(r.wasTruncated).toBe(false);
  });

  it('truncates content over the limit', () => {
    const tool = mockTool({ outputLimit: 100 });
    const long = 'x'.repeat(5000);
    const r = ToolPipeline.normalizeOutput(makeResult(long), tool);
    expect(r.content.length).toBeLessThan(long.length);
    expect(r.content).toContain('chars truncated');
    expect(r.wasTruncated).toBe(true);
  });

  it('uses default limit when tool has no outputLimit', () => {
    const tool = mockTool({ outputLimit: undefined });
    const short = 'hello';
    const r = ToolPipeline.normalizeOutput(makeResult(short), tool);
    expect(r.content).toBe(short);
  });

  it('passes through empty content', () => {
    const tool = mockTool({ outputLimit: 100 });
    const r = ToolPipeline.normalizeOutput(makeResult(''), tool);
    expect(r.content).toBe('');
  });
});
