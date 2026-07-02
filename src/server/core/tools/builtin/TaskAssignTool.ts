// TaskAssignTool — delegate a task to a subordinate agent
// Creates a sub-session for the subordinate and runs their AgentLoop
// with the task as a user message. Returns the sub-session ID.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { createLogger } from '../../logger.js';

export class TaskAssignTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Dispatches a task to a subordinate agent (non-blocking — returns immediately).';
  name(): string {
    return 'TaskAssign';
  }

  description(): string {
    return 'Dispatch a task to a subordinate agent. Returns immediately — the subordinate works independently in background. The system delivers a <task-notification> when the task finishes. Use TaskList to check progress, TaskOutput to retrieve results.';
  }

  prompt(): string {
    return '## TaskAssign Usage\n' +
      'Delegate work to a direct subordinate. The task runs in background.\n\n' +
      '**CRITICAL — Before delegating:**\n' +
      '1. Check your Active Background Tasks list in the system prompt — is this agent already busy?\n' +
      '2. If yes, use AgentMessage to add requirements, NOT a second TaskAssign\n' +
      '3. One agent = one active task. Duplicate assignments create chaos.\n\n' +
      '**Workflow:**\n' +
      '1. TaskAssign → delegate the task with clear specs, then move on\n' +
      '2. TaskList → check progress (sparingly — once per major turn if idle)\n' +
      '3. TaskOutput → retrieve results when done\n' +
      '4. TaskStop → cancel if needed\n\n' +
      '**Task description must include:** clear goal, target files/area, acceptance criteria, priority.\n' +
      '**Match by expertise** — assign frontend work to frontend specialists, backend to backend.\n' +
      '**After delegating**, continue your own work or wait. You WILL be notified when it completes. Do NOT re-delegate the same work — the notification will arrive automatically.';
  }

  minRole(): string { return 'Manager'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'ID of the subordinate agent to delegate the task to',
        },
        task: {
          type: 'string',
          description: 'The task description and instructions for the subordinate',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Task priority. Default: "normal".',
        },
      },
      required: ['targetAgentId', 'task'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  isAsync(): boolean {
    return true; // Non-blocking — delegateTask now returns immediately
  }

  defaultTimeoutMs(): number {
    return 30000; // The dispatch itself is fast; delegateTask returns in ~100ms
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const targetAgentId = params.targetAgentId as string;
    const task = params.task as string;
    const priority = (params.priority as string) || 'normal';

    const logger = createLogger('anochat.tools');
    logger.debug('TaskAssign executed', { targetAgentId, taskPreview: task.slice(0, 60), sid: ctx.sessionId, aid: ctx.agentId });

    // ── Validate subordinate relationship ──
    // Task can only be delegated down the org tree.
    const registry = AgentRegistry.getInstance();
    const target = registry.findAgent(targetAgentId);
    if (!target) {
      return this.makeError(`Target agent '${targetAgentId}' not found in registry`);
    }
    // Check the target's report chain includes the caller — means caller is an ancestor
    const chain = registry.reportChain(target.id);
    if (!chain.includes(ctx.agentId) && target.parentAgentId !== ctx.agentId) {
      logger.warn('TaskAssign validation failed — not a subordinate', { targetAgentId, callerAid: ctx.agentId });
      return this.makeError(
        `Cannot assign task to '${targetAgentId}': ` +
        'tasks can only be delegated to subordinates (down the org tree).',
      );
    }

    const runtime = AgentRuntime.getInstance();

    // Delegate task (non-blocking — returns immediately after dispatching)
    const result = await runtime.delegateTask(targetAgentId, task, ctx.sessionId, ctx.agentId);

    if (!result.success) {
      return result;
    }

    return this.makeResult(
      `Task dispatched to '${targetAgentId}'.\n` +
      `Priority: ${priority}\n` +
      `${result.content}\n\n` +
      'The system will notify you when the task completes.',
    );
  }
}
