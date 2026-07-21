/**
 * ExecutionPlan — executes a TaskDAG in dependency-ordered parallel batches.
 *
 * For each batch of ready tasks, runs them in parallel via AgentRuntime.delegateTask(),
 * waits for all to complete, then proceeds to the next batch. Tracks results in the DAG.
 *
 * @module ExecutionPlan
 */

import type { AgentRegistry } from './AgentRegistry.js';
import { AgentRuntime } from './AgentRuntime.js';
import { TaskDAG, type TaskNode } from './TaskDAG.js';
import { createLogger } from '../logger.js';
import { TASK_TIMEOUT_SEC } from '../../../shared/constants.js';
import { InterruptController, InterruptReason } from './supervision/InterruptController.js';

export class ExecutionPlan {
  private _dag: TaskDAG;
  private _registry: AgentRegistry;

  /** Maximum total execution time for the plan, from shared constants. */
  private static TIMEOUT_MS = TASK_TIMEOUT_SEC * 1000;

  constructor(dag: TaskDAG, registry: AgentRegistry) {
    this._dag = dag;
    this._registry = registry;
  }

  /**
   * Execute the full plan. Returns a map of taskId to result string.
   * Each batch runs in parallel; batches are sequential by dependency order.
   */
  async execute(parentSessionId: string, parentAgentId: string): Promise<Map<string, string>> {
    const logger = createLogger('anochat.agent');
    const startedAt = Date.now();
    const results = new Map<string, string>();
    const runtime = AgentRuntime.getInstance();

    while (!this._dag.isComplete()) {
      // Check overall timeout
      if (Date.now() - startedAt > ExecutionPlan.TIMEOUT_MS) {
        logger.warn('ExecutionPlan timed out', { parentSessionId, parentAgentId });
        for (const task of this._dag.tasks.values()) {
          if (task.status === 'pending' || task.status === 'running') {
            task.status = 'failed';
            task.result = 'Plan timeout';
            results.set(task.id, 'Plan timeout');
          }
        }
        break;
      }

      const batch = this._dag.getReadyTasks();
      if (batch.length === 0) {
        // No ready tasks but not complete — a dependency is stuck or failed.
        // Check for orphaned tasks (dependencies that are failed or missing).
        const orphaned = this._findOrphanedTasks();
        if (orphaned.length > 0) {
          for (const task of orphaned) {
            task.status = 'failed';
            task.result = 'Dependency failed or missing';
            results.set(task.id, task.result);
          }
          continue;
        }
        // Safety: if nothing is ready and nothing is orphaned, break to avoid infinite loop
        logger.warn('ExecutionPlan stalled — no ready tasks, no orphans', {
          parentSessionId, parentAgentId, summary: this._dag.summary(),
        });
        break;
      }

      // Mark batch as running
      for (const task of batch) {
        task.status = 'running';
        task.startedAt = Date.now();
      }

      logger.info('ExecutionPlan batch starting', {
        parentSessionId,
        batchSize: batch.length,
        taskIds: batch.map(t => t.id),
      });

      // Run all tasks in this batch in parallel
      const batchPromises = batch.map(async (task) => {
        try {
          // Validate agent exists and is available
          const agent = this._registry.findAgent(task.agentId);
          if (!agent || !agent.isActive) {
            task.status = 'failed';
            task.result = `Agent ${task.agentId} not available`;
            task.completedAt = Date.now();
            return;
          }

          const result = await runtime.delegateTask(
            task.agentId,
            task.description,
            parentSessionId,
            parentAgentId,
          );

          if (result.success) {
            task.status = 'completed';
            task.result = result.content;
          } else {
            task.status = 'failed';
            task.result = result.errorMessage || 'Delegation failed';
          }
        } catch (err) {
          task.status = 'failed';
          task.result = err instanceof Error ? err.message : String(err);
        }
        task.completedAt = Date.now();
        results.set(task.id, task.result || '');
      });

      const remainingMs = Math.max(1, ExecutionPlan.TIMEOUT_MS - (Date.now() - startedAt));
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), remainingMs);
      });
      const outcome = await Promise.race([
        Promise.allSettled(batchPromises).then(() => 'completed' as const),
        deadline,
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (outcome === 'timeout') {
        InterruptController.getInstance().requestInterrupt(parentSessionId, InterruptReason.Timeout);
        for (const task of batch) {
          if (task.status === 'running') {
            task.status = 'failed';
            task.result = 'Plan timeout';
            task.completedAt = Date.now();
            results.set(task.id, task.result);
          }
        }
        break;
      }
    }

    const elapsed = Date.now() - startedAt;
    logger.info('ExecutionPlan completed', {
      parentSessionId,
      parentAgentId,
      elapsedMs: elapsed,
      summary: this._dag.summary(),
    });

    return results;
  }

  /**
   * Find tasks whose dependencies include at least one failed or missing task.
   * These tasks can never become ready and should be marked as failed.
   *
   * @returns Array of orphaned tasks that depend on failed or missing tasks.
   */
  private _findOrphanedTasks(): TaskNode[] {
    const orphaned: TaskNode[] = [];
    for (const task of this._dag.tasks.values()) {
      if (task.status !== 'pending') continue;
      for (const depId of task.dependsOn) {
        const dep = this._dag.tasks.get(depId);
        if (!dep || dep.status === 'failed') {
          orphaned.push(task);
          break;
        }
      }
    }
    return orphaned;
  }
}
