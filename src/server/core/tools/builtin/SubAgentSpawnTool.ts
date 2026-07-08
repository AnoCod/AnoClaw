// SubAgentSpawnTool - create a temporary SubAgent for one-off tasks
// The SubAgent is destroyed after completion (or error). Does NOT persist to org tree.
// Uses AgentRuntime.spawnSubAgent().

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { SubAgentConfig } from '../../../../shared/types/agent.js';
import { createLogger } from '../../logger.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

const SUBAGENT_TYPES = ['Explore', 'Plan', 'general-purpose'] as const;

const SUBAGENT_MODELS = ['haiku', 'sonnet'] as const;

export class SubAgentSpawnTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Creates a temporary helper agent for isolated research, planning, or parallel execution.';
  name(): string {
    return 'SubAgentSpawn';
  }

  description(): string {
    return 'Create a temporary SubAgent for one-off work. Use it for isolated exploration, planning, or parallel execution. Persistent team work belongs in TaskAssign to a permanent subordinate.';
  }

  prompt(): string {
    return [
      '## SubAgentSpawn Usage',
      'Use a SubAgent for bounded temporary work that should not become durable org context.',
      '',
      'Good uses:',
      '- Independent codebase exploration.',
      '- Drafting or checking an implementation plan.',
      '- Parallel verification on a separate area.',
      '- Research where the result can be summarized and discarded.',
      '',
      'Do not use SubAgentSpawn for simple reads/searches, known file edits, or durable team responsibilities. Use direct tools or TaskAssign instead.',
      '',
      'Prompt requirements: one clear task, relevant context, constraints, expected output, and verification expectations.',
      'Set persist=true only when the transcript is needed for audit, forensics, or later review.',
    ].join('\n');
  }

  minRole(): string { return 'Member'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          pattern: '\\S',
          description: 'Short description of what this SubAgent should accomplish (used for logging and UI)',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Full task prompt / instructions for the SubAgent to execute',
        },
        subagent_type: {
          type: 'string',
          enum: [...SUBAGENT_TYPES],
          description: 'Type of SubAgent. "Explore" for codebase investigation, "Plan" for design work, "general-purpose" for open-ended tasks.',
        },
        model: {
          type: 'string',
          enum: [...SUBAGENT_MODELS],
          description: 'Model to use for the SubAgent. "haiku" is faster/cheaper, "sonnet" is more capable. Defaults to "sonnet".',
        },
        persist: {
          type: 'boolean',
          description: 'If true, keep the SubAgent alive after completion (idle, 1h TTL) for later inspection, forensics, or reuse. Default: false.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'If true, run the SubAgent in the background (fire-and-forget). The result will be delivered to the parent session when complete. Default: false.',
        },
      },
      required: ['description', 'prompt', 'subagent_type'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  isAsync(): boolean {
    return true;
  }

  defaultTimeoutMs(): number {
    return 300000; // 5 minutes for SubAgent tasks
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const descriptionResult = normalizeString(params.description, 'description', 200);
    if (descriptionResult.error) return this.makeError(descriptionResult.error);
    const description = descriptionResult.value!;

    const promptResult = normalizeString(params.prompt, 'prompt');
    if (promptResult.error) return this.makeError(promptResult.error);
    const prompt = promptResult.value!;

    const subagentTypeResult = normalizeEnum(params.subagent_type, 'subagent_type', SUBAGENT_TYPES);
    if (subagentTypeResult.error) return this.makeError(subagentTypeResult.error);
    const subagentType = subagentTypeResult.value!;

    const modelResult = normalizeEnum(params.model, 'model', SUBAGENT_MODELS, 'sonnet');
    if (modelResult.error) return this.makeError(modelResult.error);
    const model = modelResult.value!;

    const persistResult = normalizeBoolean(params.persist, 'persist', false);
    if (persistResult.error) return this.makeError(persistResult.error);
    const persist = persistResult.value!;

    const backgroundResult = normalizeBoolean(params.run_in_background, 'run_in_background', false);
    if (backgroundResult.error) return this.makeError(backgroundResult.error);
    const runInBackground = backgroundResult.value!;

    const logger = createLogger('anochat.tools');
    logger.debug('SubAgentSpawn execute', { type: subagentType, model, background: runInBackground, sid: ctx.sessionId, aid: ctx.agentId });

    const subAgentConfig: SubAgentConfig = {
      description,
      prompt,
      subagent_type: subagentType,
      model,
      persist,
      run_in_background: runInBackground,
    };

    const runtime = AgentRuntime.getInstance();

    if (runInBackground) {
      // Fire-and-forget: start the SubAgent asynchronously.
      // BackgroundTaskManager delivers completion/failure notifications and
      // lets AgentLoop wait eventfully instead of hanging or polling blindly.
      const startedAt = Date.now();
      const bgManager = BackgroundTaskManager.getInstance();
      const taskId = bgManager.register({
        type: 'subagent',
        parentSessionId: ctx.sessionId,
        parentAgentId: ctx.agentId,
        summary: description.slice(0, 80),
      });

      runtime.spawnSubAgent(subAgentConfig, ctx.agentId, ctx.sessionId).then(async (result) => {
        const durationMs = Date.now() - startedAt;
        const subSessionId = (result.structured as any)?.subSessionId || `subagent-${Date.now()}`;

        if (!result.success) {
          const errorMessage = result.errorMessage || result.content || 'SubAgent execution failed with no error message';
          logger.error('Background SubAgent returned failure', { type: subagentType, error: errorMessage.slice(0, 200), sid: ctx.sessionId, taskId });
          TypedEventBus.emit('delegation:error', {
            parentSessionId: ctx.sessionId,
            subSessionId,
            subAgentId: `SubAgent-${subagentType}`,
            taskSummary: description.slice(0, 60),
            elapsedMs: durationMs,
          });
          await finishBackgroundFailure(bgManager, taskId, errorMessage, durationMs, logger);
          return;
        }

        TypedEventBus.emit('delegation:completed', {
          parentSessionId: ctx.sessionId,
          subSessionId,
          subAgentId: `SubAgent-${subagentType}`,
          taskSummary: description.slice(0, 60),
          turnCount: 0,
          elapsedMs: durationMs,
        });
        await finishBackgroundSuccess(bgManager, taskId, result.content || '(no output)', durationMs, logger);
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;
        logger.error('Background SubAgent failed', { type: subagentType, error: errMsg, sid: ctx.sessionId, taskId });
        TypedEventBus.emit('delegation:error', {
          parentSessionId: ctx.sessionId,
          subSessionId: `subagent-err-${Date.now()}`,
          subAgentId: `SubAgent-${subagentType}`,
          taskSummary: description.slice(0, 60),
          elapsedMs: durationMs,
        });
        finishBackgroundFailure(bgManager, taskId, errMsg, durationMs, logger).catch((failErr) => {
          logger.warn('Failed to record background SubAgent failure', { taskId, error: (failErr as Error).message });
        });
      });

      return this.makeResult(
        `SubAgent spawned in background: ${description}\n` +
        `Task ID: ${taskId}\n` +
        `Type: ${subagentType}\n` +
        `Model: ${model}\n` +
        `The result will be delivered when complete via <task-notification>. Use TaskOutput with task_id="${taskId}" to inspect it later.`,
        { structured: { taskId, background: true } },
      );
    }

    // Synchronous: wait for the SubAgent to complete
    const result = await runtime.spawnSubAgent(subAgentConfig, ctx.agentId, ctx.sessionId);

    if (result.success) {
      return result;
    } else {
      return this.makeError(
        result.errorMessage ?? 'SubAgent execution failed with no error message',
      );
    }
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength?: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (maxLength !== undefined && trimmed.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or less` };
  }
  return { value: trimmed };
}

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'boolean') return { error: `${field} must be a boolean` };
  return { value };
}

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  fallback?: T[number],
): { value: T[number]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return { value: fallback };
    return { error: `${field} is required` };
  }
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (!allowed.includes(value)) {
    return { error: `${field} must be one of: ${allowed.join(', ')}` };
  }
  return { value };
}

async function finishBackgroundSuccess(
  bgManager: BackgroundTaskManager,
  taskId: string,
  content: string,
  durationMs: number,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    if (bgManager.hasTask(taskId)) {
      await bgManager.complete(taskId, { content, turnCount: 0, durationMs });
    }
  } catch (err) {
    logger.warn('Failed to record background SubAgent completion', { taskId, error: (err as Error).message });
  }
}

async function finishBackgroundFailure(
  bgManager: BackgroundTaskManager,
  taskId: string,
  errorMessage: string,
  durationMs: number,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    if (bgManager.hasTask(taskId)) {
      await bgManager.fail(taskId, errorMessage, durationMs);
    }
  } catch (err) {
    logger.warn('Failed to record background SubAgent failure', { taskId, error: (err as Error).message });
  }
}
