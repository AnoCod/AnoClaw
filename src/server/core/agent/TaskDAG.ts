/**
 * TaskDAG — Directed Acyclic Graph for parallel task orchestration.
 *
 * Tracks task nodes with dependency edges. Supports querying
 * ready-to-run tasks and completion status for batch execution.
 *
 * @module TaskDAG
 */

export interface TaskNode {
  id: string;
  agentId: string;
  description: string;
  dependsOn: string[];    // task IDs this task depends on
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  startedAt?: number;
  completedAt?: number;
}

export class TaskDAG {
  tasks: Map<string, TaskNode> = new Map();

  /** Add a task node to the DAG. Rejects duplicate IDs silently (last wins).
   *  Throws if the new task would create a dependency cycle. */
  addTask(task: TaskNode): void {
    // Cycle detection: check if any dependency transitively depends on the new task
    for (const depId of task.dependsOn) {
      if (depId === task.id) {
        throw new Error(`Task "${task.id}" cannot depend on itself`);
      }
      if (this._wouldCreateCycle(depId, task.id)) {
        throw new Error(`Adding "${task.id}" would create a cycle via "${depId}"`);
      }
    }
    this.tasks.set(task.id, { ...task });
  }

  /** BFS: return true if startId transitively depends on targetId. */
  private _wouldCreateCycle(startId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this.tasks.get(current);
      if (node) {
        for (const dep of node.dependsOn) {
          if (!visited.has(dep)) queue.push(dep);
        }
      }
    }
    return false;
  }

  /**
   * Get tasks that are ready to run: all dependencies have status='completed',
   * and the task itself is still 'pending'.
   */
  getReadyTasks(): TaskNode[] {
    const ready: TaskNode[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const depsReady = task.dependsOn.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });
      if (depsReady) ready.push(task);
    }
    return ready;
  }

  /** Whether all tasks are in a terminal state (completed or failed). */
  isComplete(): boolean {
    if (this.tasks.size === 0) return true;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') return false;
    }
    return true;
  }

  /** Simple completion summary: counts by status. */
  summary(): string {
    let pending = 0, running = 0, completed = 0, failed = 0;
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'pending': pending++; break;
        case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
      }
    }
    return `Tasks: ${completed} completed, ${failed} failed, ${running} running, ${pending} pending`;
  }
}
