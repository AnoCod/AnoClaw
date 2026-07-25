import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../../shared/types/session.js';
import type { ToolResult } from '../../../../../shared/types/tool.js';
import type { WorkspaceLeaseRecord } from '../../../../../shared/types/v3/index.js';
import { Tool } from '../../../tools/Tool.js';
import { ToolPipeline } from '../../../tools/ToolPipeline.js';
import {
  V3ToolExecutionRegistry,
  type V3ToolExecutionContext,
} from '../V3ToolExecutionRegistry.js';

class FakeWriteTool extends Tool {
  executions = 0;

  name(): string { return 'FakeWrite'; }
  description(): string { return 'writes one test file'; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    };
  }
  workspacePathParams(): string[] { return ['path']; }
  async execute(): Promise<ToolResult> {
    this.executions += 1;
    return this.makeResult('written');
  }
}

class FakeReadTool extends FakeWriteTool {
  override name(): string { return 'FakeRead'; }
  override isReadOnly(): boolean { return true; }
}

class FakeDomainMutationTool extends Tool {
  name(): string { return 'TeamCreate'; }
  description(): string { return 'creates a persistent Team'; }
  parametersSchema(): Record<string, unknown> { return { type: 'object' }; }
  async execute(): Promise<ToolResult> { return this.makeResult('created'); }
}

describe('V3ToolExecutionRegistry', () => {
  afterEach(() => V3ToolExecutionRegistry.resetInstance());

  it('blocks writes outside declared scope and stale or missing leases', () => {
    const registry = V3ToolExecutionRegistry.getInstance();
    const tool = new FakeWriteTool();
    registry.register(context());

    expect(registry.validate('session-1', tool, { path: 'src/index.ts' })).toEqual({
      allowed: true,
    });
    expect(registry.validate('session-1', tool, { path: 'docs/readme.md' })).toMatchObject({
      allowed: false,
      code: 'undeclared_write_scope',
    });

    registry.register(context({
      activeLeases: [lease({ fencingToken: 6 })],
    }));
    expect(registry.validate('session-1', tool, { path: 'src/index.ts' })).toMatchObject({
      allowed: false,
      code: 'lease_missing',
    });
  });

  it('blocks all mutation tools for a read-only Task but permits reads', () => {
    const registry = V3ToolExecutionRegistry.getInstance();
    registry.register(context({ readOnly: true, writeScope: [], activeLeases: [] }));
    expect(registry.validate('session-1', new FakeWriteTool(), { path: 'src/a.ts' })).toMatchObject({
      allowed: false,
      code: 'read_only_task',
    });
    expect(registry.validate('session-1', new FakeReadTool(), { path: 'src/a.ts' })).toEqual({
      allowed: true,
    });
  });

  it('allows domain mutations without requiring a Workspace lease', () => {
    const registry = V3ToolExecutionRegistry.getInstance();
    const primaryContext = context({
      activeLeases: [],
      allowedTools: ['TeamCreate'],
    });
    delete primaryContext.workspaceId;
    delete primaryContext.workspaceRoot;
    registry.register(primaryContext);
    expect(registry.validate('session-1', new FakeDomainMutationTool(), {})).toEqual({
      allowed: true,
    });
  });

  it('wraps execution with durable prepared, started, and finished journal hooks', async () => {
    const calls: string[] = [];
    const registry = V3ToolExecutionRegistry.getInstance();
    registry.register(context({
      journal: {
        async prepare(input) {
          calls.push(`prepare:${input.toolCallId}:${input.toolName}`);
          return 'journal-1';
        },
        async markStarted(recordId) {
          calls.push(`started:${recordId}`);
        },
        async markFinished(recordId, result) {
          calls.push(`finished:${recordId}:${result.success}`);
        },
        async markTranscriptCommitted(toolCallId) {
          calls.push(`committed:${toolCallId}`);
        },
      },
    }));
    const tool = new FakeWriteTool();
    const result = await ToolPipeline.run(
      tool,
      { path: 'src/index.ts' },
      executionContext(),
      'call-1',
    );
    expect(result.success).toBe(true);
    expect(tool.executions).toBe(1);
    expect(calls).toEqual([
      'prepare:call-1:FakeWrite',
      'started:journal-1',
      'finished:journal-1:true',
    ]);

    await registry.markTranscriptCommitted('session-1', 'call-1');
    expect(calls.at(-1)).toBe('committed:call-1');
  });

  it('does not execute when durable journal preparation fails', async () => {
    const registry = V3ToolExecutionRegistry.getInstance();
    registry.register(context({
      journal: {
        async prepare() { throw new Error('event store unavailable'); },
        async markStarted() {},
        async markFinished() {},
        async markTranscriptCommitted() {},
      },
    }));
    const tool = new FakeWriteTool();
    const result = await ToolPipeline.run(
      tool,
      { path: 'src/index.ts' },
      executionContext(),
      'call-2',
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('execution was not started');
    expect(tool.executions).toBe(0);
  });
});

function executionContext(): ExecutionContext {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    workspace: 'C:\\workspace',
    userConfirmed: true,
    mode: 'auto_edit',
  };
}

function context(overrides: Partial<V3ToolExecutionContext> = {}): V3ToolExecutionContext {
  return {
    workId: 'work-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    runId: 'run-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    workspaceRoot: 'C:\\workspace',
    readOnly: false,
    writeScope: ['src'],
    fencingToken: 5,
    activeLeases: [lease()],
    allowedTools: ['FakeWrite', 'FakeRead'],
    ...overrides,
  };
}

function lease(overrides: Partial<WorkspaceLeaseRecord> = {}): WorkspaceLeaseRecord {
  return {
    id: 'lease-1',
    workId: 'work-1',
    workspaceId: 'workspace-1',
    writeScope: ['src'],
    ownerRunId: 'run-1',
    ownerTaskId: 'task-1',
    ownerAgentId: 'agent-1',
    fencingToken: 5,
    status: 'active',
    acquiredAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}
