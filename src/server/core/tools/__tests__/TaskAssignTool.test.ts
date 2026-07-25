import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { WorkspaceLeaseService } from '../../coordination/WorkspaceLeaseService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { TaskAssignTool } from '../builtin/TaskAssignTool.js';

const ctx: ExecutionContext = {
  sessionId: 'root-1',
  agentId: 'manager-1',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('TaskAssignTool durable contract', () => {
  let dir = '';
  let service: CoordinationService;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-task-assign-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId })),
    } as unknown as SessionManager);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('assigns an existing hierarchy task to a direct subordinate', async () => {
    const task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Inspect',
      description: 'Inspect code',
      acceptanceCriteria: ['Evidence'],
      creatorAgentId: ctx.agentId,
      readOnly: true,
    });
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn((id: string) => id === 'member-1'
        ? { id, isActive: true, parentAgentId: ctx.agentId }
        : undefined),
    } as unknown as AgentRegistry);

    const result = await new TaskAssignTool().execute({
      taskId: task.id,
      targetAgentId: 'member-1',
      expectedVersion: task.version,
    }, ctx);

    expect(result.success).toBe(true);
    expect(service.getTask('root-1', task.id)).toMatchObject({
      assigneeAgentId: 'member-1',
      status: 'pending',
    });
    expect(service.pendingMessages('root-1', 'member-1')[0]).toMatchObject({
      kind: 'task_assignment',
      taskId: task.id,
    });
  });

  it('rejects hierarchy assignment outside the direct reporting edge', async () => {
    const task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Inspect',
      description: 'Inspect code',
      acceptanceCriteria: ['Evidence'],
      creatorAgentId: ctx.agentId,
      readOnly: true,
    });
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn(() => ({ id: 'member-1', isActive: true, parentAgentId: 'other-manager' })),
    } as unknown as AgentRegistry);

    const result = await new TaskAssignTool().execute({
      taskId: task.id,
      targetAgentId: 'member-1',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('direct subordinate');
    expect(service.getTask('root-1', task.id)?.assigneeAgentId).toBeUndefined();
  });
});
