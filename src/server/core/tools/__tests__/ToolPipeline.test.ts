import { describe, it, expect, vi } from 'vitest';
import { ToolPipeline } from '../ToolPipeline.js';
import { RiskLevel, InterruptBehavior, type ToolResult } from '../../../../shared/types/tool.js';
import type { Tool } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { makeResult, makeError } from '../ToolResult.js';
import { PlanTool } from '../builtin/PlanTool.js';

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
    requiresConfirmation: () => (overrides.requiresConfirmation as boolean) ?? false,
    isReadOnly: () => (overrides.isReadOnly as boolean) ?? true,
    isDestructive: () => (overrides.isDestructive as boolean) ?? false,
    workspacePathParams: () => (overrides.workspacePathParams as string[]) ?? [],
    maxRetries: () => (overrides.maxRetries as number) ?? 3,
    defaultTimeoutMs: () => (overrides.defaultTimeoutMs as number) ?? 30000,
    outputLimit: () => (overrides.outputLimit as number) ?? 10000,
    interruptBehavior: () => (overrides.interruptBehavior as InterruptBehavior) ?? InterruptBehavior.Cancel,
    _executeWithEvents: (overrides._executeWithEvents as Tool['_executeWithEvents'])
      ?? vi.fn().mockResolvedValue(makeResult('ok')),
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

  it('validates required fields inside array object items', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['question', 'header'],
              properties: {
                question: { type: 'string' },
                header: { type: 'string' },
              },
            },
          },
        },
      },
    });

    const r = ToolPipeline.validateParams(tool, { questions: [{ question: 'Proceed?' }] });

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('questions[0].header');
  });

  it('validates nested array item types', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                options: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
        required: [],
      },
    });

    const r = ToolPipeline.validateParams(tool, {
      questions: [{ options: ['yes', 2] }],
    });

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('questions[0].options[1]');
    expect(r!.errorMessage).toContain('expected string');
  });

  it('validates string length and numeric ranges when schemas declare them', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', minLength: 3, maxLength: 8 },
          count: { type: 'number', minimum: 1, maximum: 5 },
        },
        required: ['label', 'count'],
      },
    });

    const short = ToolPipeline.validateParams(tool, { label: 'ab', count: 3 });
    expect(short).not.toBeNull();
    expect(short!.errorMessage).toContain('at least 3');

    const large = ToolPipeline.validateParams(tool, { label: 'valid', count: 6 });
    expect(large).not.toBeNull();
    expect(large!.errorMessage).toContain('expected <= 5');

    expect(ToolPipeline.validateParams(tool, { label: 'valid', count: 5 })).toBeNull();
  });

  it('allows arbitrary object content when an object schema leaves properties open', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        properties: {
          params: { type: 'object' },
        },
        required: ['params'],
      },
    });

    expect(ToolPipeline.validateParams(tool, {
      params: { id: 'agent-1', nested: { ok: true }, count: 2 },
    })).toBeNull();
  });

  it('rejects unexpected object properties only when additionalProperties is false', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        properties: {
          known: { type: 'string' },
        },
        additionalProperties: false,
        required: ['known'],
      },
    });

    const r = ToolPipeline.validateParams(tool, { known: 'ok', surprise: true });

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('Unexpected parameter: "surprise"');
  });

  it('validates string patterns when schemas declare them', () => {
    const tool = mockTool({
      parametersSchema: {
        type: 'object',
        properties: {
          hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        required: ['hash'],
      },
    });

    const r = ToolPipeline.validateParams(tool, { hash: 'not-a-sha' });

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('Invalid format');
    expect(ToolPipeline.validateParams(tool, { hash: 'a'.repeat(64) })).toBeNull();
  });
});

// ── Stage 1: securityCheck ──

describe('ToolPipeline.securityCheck', () => {
  it('blocks tools that require confirmation', () => {
    const tool = mockTool({ requiresConfirmation: true });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: false }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('confirmation');
  });

  it('allows tools that do not require confirmation', () => {
    const tool = mockTool({ requiresConfirmation: false });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: false }))).toBeNull();
  });

  it('allows low-risk tools without confirmation', () => {
    const tool = mockTool({ riskLevel: RiskLevel.Low });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ userConfirmed: false }))).toBeNull();
  });

  it('allows an exact Bash command approved while exiting plan mode', () => {
    const sessionId = 'allowed-bash-exact-session';
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: 'npm test' }]);
    const tool = mockTool({
      name: 'Bash',
      isReadOnly: false,
      riskLevel: RiskLevel.High,
      requiresConfirmation: true,
    });

    const r = ToolPipeline.securityCheck(
      tool,
      { command: 'npm test' },
      ctx({ sessionId, userConfirmed: false }),
    );

    expect(r).toBeNull();
  });

  it('does not treat an approved Bash command as approval for every Bash command', () => {
    const sessionId = 'allowed-bash-mismatch-session';
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: 'npm test' }]);
    const tool = mockTool({
      name: 'Bash',
      isReadOnly: false,
      riskLevel: RiskLevel.High,
      requiresConfirmation: true,
    });

    const r = ToolPipeline.securityCheck(
      tool,
      { command: 'git push' },
      ctx({ sessionId, userConfirmed: false }),
    );

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('confirmation');
  });

  it('keeps approved Bash commands scoped to the session that approved them', () => {
    ToolPipeline.setAllowedPrompts('allowed-bash-session-a', [{ tool: 'Bash', prompt: 'npm test' }]);
    const tool = mockTool({
      name: 'Bash',
      isReadOnly: false,
      riskLevel: RiskLevel.High,
      requiresConfirmation: true,
    });

    const r = ToolPipeline.securityCheck(
      tool,
      { command: 'npm test' },
      ctx({ sessionId: 'allowed-bash-session-b', userConfirmed: false }),
    );

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('confirmation');
  });

  it('normalizes whitespace before matching approved Bash commands', () => {
    const sessionId = 'allowed-bash-whitespace-session';
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: '  npm test  ' }]);
    const tool = mockTool({
      name: 'Bash',
      isReadOnly: false,
      riskLevel: RiskLevel.High,
      requiresConfirmation: true,
    });

    const r = ToolPipeline.securityCheck(
      tool,
      { command: 'npm test' },
      ctx({ sessionId, userConfirmed: false }),
    );

    expect(r).toBeNull();
    expect(ToolPipeline.getAllowedPrompts(sessionId)).toEqual([{ tool: 'Bash', prompt: 'npm test' }]);
  });

  it('does not let approved Bash commands bypass read-only mode', () => {
    const sessionId = 'allowed-bash-read-only-session';
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: 'npm test' }]);
    const tool = mockTool({
      name: 'Bash',
      isReadOnly: false,
      riskLevel: RiskLevel.High,
      requiresConfirmation: true,
    });

    const r = ToolPipeline.securityCheck(
      tool,
      { command: 'npm test' },
      ctx({ sessionId, mode: 'read_only', userConfirmed: false }),
    );

    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('read_only');
  });

  it('blocks non-read-only tools in read_only mode', () => {
    const tool = mockTool({ isReadOnly: false });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'read_only' }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('read_only');
  });

  it('allows read-only tools in read_only mode', () => {
    const tool = mockTool({ isReadOnly: true });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'read_only' }))).toBeNull();
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
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'readOnly' }));
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('readOnly');
  });

  it('allows Ask mode writes (confirmation handled by AgentLoop)', () => {
    const tool = mockTool({ name: 'Write', isReadOnly: false, riskLevel: RiskLevel.Medium });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'ask' }));
    expect(r).toBeNull();
  });

  it('allows low-risk edits in Safe Auto mode (confirmation handled by AgentLoop)', () => {
    const tool = mockTool({
      name: 'Edit',
      isReadOnly: false,
      isDestructive: true,
      riskLevel: RiskLevel.Low,
    });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'auto' }));
    expect(r).toBeNull();
  });

  it('allows non-read-only tools in Safe Auto mode (confirmation handled by AgentLoop)', () => {
    const tool = mockTool({
      name: 'MemorySave',
      isReadOnly: false,
      isDestructive: false,
      riskLevel: RiskLevel.Low,
    });
    const r = ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'auto' }));
    expect(r).toBeNull();
  });

  it('allows low-risk edits in Auto-Edit mode', () => {
    const tool = mockTool({
      name: 'Edit',
      isReadOnly: false,
      isDestructive: true,
      riskLevel: RiskLevel.Low,
    });
    expect(ToolPipeline.securityCheck(tool, {}, ctx({ mode: 'auto_edit' }))).toBeNull();
  });

  it('treats PlanTool as file-changing in read_only mode', () => {
    const r = ToolPipeline.securityCheck(
      new PlanTool(),
      { name: 'audit', content: 'steps' },
      ctx({ mode: 'read_only' }),
    );
    expect(r).not.toBeNull();
    expect(r!.errorMessage).toContain('read_only');
  });
});

// ── Stage 2: execution watchdog ──

describe('ToolPipeline.execute watchdog', () => {
  it('returns a timeout failure when a tool never settles', async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool = mockTool({
      name: 'SlowTool',
      defaultTimeoutMs: 10,
      _executeWithEvents: vi.fn((_params, execCtx: ExecutionContext) => {
        receivedSignal = execCtx.signal;
        return new Promise<ToolResult>(() => {});
      }),
    });

    const result = await ToolPipeline.execute(tool, {}, ctx(), 'tc-timeout');

    expect(result.success).toBe(false);
    expect(result.toolCallId).toBe('tc-timeout');
    expect(result.errorMessage).toContain('timed out');
    expect(result.structured).toMatchObject({
      toolName: 'SlowTool',
      pipelineFailure: 'timeout',
      timeoutMs: 100,
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('returns an interrupt failure when the session signal aborts during execution', async () => {
    const controller = new AbortController();
    const tool = mockTool({
      name: 'InterruptibleTool',
      defaultTimeoutMs: 1000,
      _executeWithEvents: vi.fn(() => new Promise<ToolResult>(() => {})),
    });

    const pending = ToolPipeline.execute(tool, {}, ctx({ signal: controller.signal }), 'tc-interrupt');
    controller.abort();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.toolCallId).toBe('tc-interrupt');
    expect(result.errorMessage).toContain('interrupted');
    expect(result.structured).toMatchObject({
      toolName: 'InterruptibleTool',
      pipelineFailure: 'interrupted',
    });
  });

  it('does not retry watchdog timeout failures', async () => {
    const tool = mockTool({
      name: 'SlowRetryTool',
      maxRetries: 3,
      _executeWithEvents: vi.fn().mockResolvedValue(makeResult('unexpected retry')),
    });
    const original = makeError('Tool "SlowRetryTool" timed out', {
      structured: { pipelineFailure: 'timeout' },
    });

    const result = await ToolPipeline.retry(tool, {}, ctx(), original);

    expect(result).toBe(original);
    expect(tool._executeWithEvents).not.toHaveBeenCalled();
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
