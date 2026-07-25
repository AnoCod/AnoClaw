import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryDeleteTool } from '../builtin/MemoryDeleteTool.js';
import { MemoryRecallTool } from '../builtin/MemoryRecallTool.js';
import { MemorySaveTool } from '../builtin/MemorySaveTool.js';
import { MemorySearchTool } from '../builtin/MemorySearchTool.js';
import { V3ScopedMemoryService } from '../../v3/memory/V3ScopedMemoryService.js';
import {
  V3ToolExecutionRegistry,
  type V3ToolExecutionContext,
} from '../../v3/runtime/V3ToolExecutionRegistry.js';

let rootDir = '';
let memory: V3ScopedMemoryService;

const executionContext: ExecutionContext = {
  sessionId: 'session-a',
  agentId: 'untrusted-execution-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

beforeEach(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-memory-tools-'));
  memory = new V3ScopedMemoryService(rootDir);
  await memory.initialize();
  V3ToolExecutionRegistry.resetInstance();
  V3ToolExecutionRegistry.getInstance().register(v3Context());
});

afterEach(async () => {
  V3ToolExecutionRegistry.resetInstance();
  await fsp.rm(rootDir, { recursive: true, force: true });
});

describe('v3 memory tools', () => {
  it('publishes only v3 memory scopes', () => {
    const schemas = [
      new MemorySaveTool(memory),
      new MemorySearchTool(memory),
      new MemoryRecallTool(memory),
      new MemoryDeleteTool(memory),
    ].map((tool) => JSON.stringify(tool.parametersSchema()));

    for (const schema of schemas) {
      expect(schema).not.toContain('session_personal');
      expect(schema).not.toContain('session_team');
      expect(schema).not.toContain('"personal"');
    }
    expect(schemas[0]).toContain('"company"');
    expect(schemas[0]).toContain('"mission"');
  });

  it('derives the agent target from server context and rejects target injection', async () => {
    const save = new MemorySaveTool(memory);
    const injected = await save.execute({
      scope: 'agent',
      type: 'reference',
      name: 'escape-attempt',
      content: 'Must not escape.',
      agentId: 'agent-other',
    }, executionContext);
    expect(injected.success).toBe(false);
    expect(injected.errorMessage).toContain('server-owned');

    const saved = await save.execute({
      scope: 'agent',
      type: 'reference',
      name: 'bound-memory',
      content: 'Bound to the registered agent.',
    }, executionContext);
    expect(saved.success).toBe(true);
    expect(saved.structured).toMatchObject({
      scope: 'agent',
      targetId: 'agent-server',
    });
    await expect(memory.get(
      { scope: 'agent', targetId: 'agent-server' },
      'bound-memory',
    )).resolves.toMatchObject({ name: 'bound-memory' });
    await expect(memory.get(
      { scope: 'agent', targetId: 'untrusted-execution-agent' },
      'bound-memory',
    )).resolves.toBeNull();
  });

  it('binds all six scopes to the registered context', async () => {
    const save = new MemorySaveTool(memory);
    const expected = {
      company: 'company-server',
      team: 'team-server',
      agent: 'agent-server',
      workspace: 'workspace-server',
      work: 'work-server',
      mission: 'mission-server',
    } as const;

    for (const [scope, targetId] of Object.entries(expected)) {
      const result = await save.execute({
        scope,
        type: 'reference',
        name: `${scope}-memory`,
        content: `${scope} content`,
      }, executionContext);
      expect(result.success).toBe(true);
      expect(result.structured).toMatchObject({ scope, targetId });
    }

    const search = await new MemorySearchTool(memory).execute({
      query: 'content',
      scope: 'all',
      limit: 10,
    }, executionContext);
    expect(search.success).toBe(true);
    expect(search.structured).toMatchObject({ count: 6, returned: 6 });
  });

  it('recalls and tombstones only within the selected current-context scope', async () => {
    await memory.save({
      scope: 'team',
      targetId: 'team-server',
      type: 'reference',
      name: 'team-policy',
      content: 'Team-only policy.',
    });
    await memory.save({
      scope: 'team',
      targetId: 'team-other',
      type: 'reference',
      name: 'team-policy',
      content: 'Other team policy.',
    });

    const recalled = await new MemoryRecallTool(memory).execute({
      id: 'team-policy',
      scope: 'team',
    }, executionContext);
    expect(recalled.success).toBe(true);
    expect(recalled.content).toContain('Team-only policy.');
    expect(recalled.content).not.toContain('Other team policy.');

    const deleted = await new MemoryDeleteTool(memory).execute({
      scope: 'team',
      name: 'team-policy',
      idempotency_key: 'delete-current-team-policy',
    }, executionContext);
    expect(deleted.success).toBe(true);
    await expect(memory.get(
      { scope: 'team', targetId: 'team-server' },
      'team-policy',
    )).resolves.toBeNull();
    await expect(memory.get(
      { scope: 'team', targetId: 'team-other' },
      'team-policy',
    )).resolves.toMatchObject({ content: 'Other team policy.' });
  });
});

function v3Context(
  overrides: Partial<V3ToolExecutionContext> = {},
): V3ToolExecutionContext {
  return {
    companyId: 'company-server',
    teamId: 'team-server',
    workId: 'work-server',
    missionId: 'mission-server',
    taskId: 'task-server',
    runId: 'run-server',
    sessionId: 'session-a',
    agentId: 'agent-server',
    workspaceId: 'workspace-server',
    workspaceRoot: process.cwd(),
    readOnly: false,
    writeScope: ['.'],
    fencingToken: 1,
    activeLeases: [],
    allowedTools: ['*'],
    ...overrides,
  };
}
