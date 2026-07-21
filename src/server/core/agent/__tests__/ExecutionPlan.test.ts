import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPlan } from '../ExecutionPlan.js';
import { TaskDAG } from '../TaskDAG.js';
import { AgentRuntime } from '../AgentRuntime.js';

describe('ExecutionPlan deadlines', () => {
  const originalTimeout = (ExecutionPlan as any).TIMEOUT_MS;

  afterEach(() => {
    (ExecutionPlan as any).TIMEOUT_MS = originalTimeout;
    vi.restoreAllMocks();
  });

  it('returns after the overall deadline when a delegated task never settles', async () => {
    (ExecutionPlan as any).TIMEOUT_MS = 20;
    vi.spyOn(AgentRuntime.getInstance(), 'delegateTask').mockImplementation(
      () => new Promise(() => {}),
    );
    const dag = new TaskDAG();
    dag.addTask({
      id: 'hung', agentId: 'worker', description: 'never returns',
      dependsOn: [], status: 'pending',
    });
    const registry = {
      findAgent: () => ({ isActive: true }),
    } as any;

    const results = await new ExecutionPlan(dag, registry).execute('parent-session', 'parent-agent');
    expect(results.get('hung')).toBe('Plan timeout');
    expect(dag.tasks.get('hung')?.status).toBe('failed');
  });
});
