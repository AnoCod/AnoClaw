import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { SubAgentConfig } from '../../../../shared/types/agent.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  rootSessionIdFor,
  stringArrayParam,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';

const TYPES = new Set<SubAgentConfig['subagent_type']>(['Explore', 'Plan', 'general-purpose']);
const CONTEXT_MODES = new Set<NonNullable<SubAgentConfig['contextMode']>>(['isolated', 'summary', 'fork']);

export class SubAgentSpawnTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Creates an ephemeral helper whose task and transcript remain durable.';
  name(): string { return 'SubAgentSpawn'; }
  description(): string {
    return 'Run a temporary Explore, Plan, or general-purpose helper with isolated, summarized, or forked context.';
  }
  prompt(): string {
    return [
      'Use SubAgentSpawn only for bounded temporary work, not as a permanent team member.',
      'The temporary Agent is always destroyed after execution; its durable Task and transcript remain available.',
      'summary is the default context mode. fork inherits full conversation and cannot be invoked by another SubAgent.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  isAsync(): boolean { return true; }
  defaultTimeoutMs(): number { return 300_000; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        description: { type: 'string', minLength: 1, maxLength: 200 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        type: { type: 'string', enum: ['Explore', 'Plan', 'general-purpose'] },
        model: { type: 'string', maxLength: 200 },
        background: { type: 'boolean' },
        contextMode: { type: 'string', enum: ['isolated', 'summary', 'fork'] },
        readOnly: { type: 'boolean' },
        writeScope: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 50 },
      },
      required: ['description', 'prompt', 'type'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const description = stringParam(params.description, 'description', 200)!;
      const prompt = stringParam(params.prompt, 'prompt', 20_000)!;
      const type = stringParam(params.type, 'type', 40)! as SubAgentConfig['subagent_type'];
      if (!TYPES.has(type)) throw new CoordinationError('validation', `Invalid type: ${type}`);
      const contextMode = (stringParam(params.contextMode, 'contextMode', 20, true) || 'summary') as NonNullable<SubAgentConfig['contextMode']>;
      if (!CONTEXT_MODES.has(contextMode)) throw new CoordinationError('validation', `Invalid contextMode: ${contextMode}`);
      const readOnly = booleanParam(params.readOnly, type !== 'general-purpose');
      const writeScope = readOnly
        ? []
        : stringArrayParam(params.writeScope, 'writeScope', { optional: true, maxItems: 50, maxLength: 500 });
      const rootSessionId = rootSessionIdFor(ctx);
      const task = await CoordinationService.getInstance().createTask({
        rootSessionId,
        sourceSessionId: ctx.sessionId,
        mode: 'subagent',
        subject: description,
        description: prompt,
        acceptanceCriteria: ['Return a concise result with verification evidence'],
        creatorAgentId: ctx.agentId,
        readOnly,
        writeScope,
      });
      const config: SubAgentConfig = {
        description,
        prompt,
        subagent_type: type,
        model: stringParam(params.model, 'model', 200, true),
        run_in_background: booleanParam(params.background, false),
        contextMode,
        readOnly,
        writeScope,
        coordinationTaskId: task.id,
      };
      const runtime = AgentRuntime.getInstance();
      if (config.run_in_background) {
        void runtime.spawnSubAgent(config, ctx.agentId, ctx.sessionId).catch(async (error) => {
          const current = CoordinationService.getInstance().getTask(rootSessionId, task.id);
          if (current && !['completed', 'failed', 'cancelled'].includes(current.status)) {
            await CoordinationService.getInstance().updateTask(rootSessionId, task.id, {
              status: current.status === 'pending' || current.status === 'claimed' ? 'cancelled' : 'failed',
              error: error instanceof Error ? error.message : String(error),
            }, ctx.agentId).catch(() => {});
          }
        });
        return this.makeResult(`SubAgent queued in background as durable task ${task.id}.`, {
          structured: { taskId: task.id, background: true, task },
        });
      }
      const result = await runtime.spawnSubAgent(config, ctx.agentId, ctx.sessionId);
      return result.success
        ? result
        : this.makeError(result.errorMessage || 'SubAgent execution failed', { structured: result.structured as Record<string, unknown> });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
