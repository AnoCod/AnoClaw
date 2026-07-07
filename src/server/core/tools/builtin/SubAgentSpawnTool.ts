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
import { MessageRole } from '../../../../shared/types/session.js';
import type { Message } from '../../../../shared/types/session.js';

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
          description: 'Short description of what this SubAgent should accomplish (used for logging and UI)',
        },
        prompt: {
          type: 'string',
          description: 'Full task prompt / instructions for the SubAgent to execute',
        },
        subagent_type: {
          type: 'string',
          enum: ['Explore', 'Plan', 'general-purpose'],
          description: 'Type of SubAgent. "Explore" for codebase investigation, "Plan" for design work, "general-purpose" for open-ended tasks.',
        },
        model: {
          type: 'string',
          enum: ['haiku', 'sonnet'],
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
    const description = params.description as string;
    const prompt = params.prompt as string;
    const subagentType = params.subagent_type as 'Explore' | 'Plan' | 'general-purpose';
    const model = (params.model as 'haiku' | 'sonnet') || 'sonnet';
    const persist = (params.persist as boolean) || false;
    const runInBackground = (params.run_in_background as boolean) || false;

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
      // When complete, emit the result via TypedEventBus to the parent session
      // and inject a system message so the main agent becomes aware.
      const startedAt = Date.now();
      runtime.spawnSubAgent(subAgentConfig, ctx.agentId, ctx.sessionId).then(async (result) => {
        const durationMs = Date.now() - startedAt;
        const subSessionId = (result.structured as any)?.subSessionId || `subagent-${Date.now()}`;
        TypedEventBus.emit('delegation:completed', {
          parentSessionId: ctx.sessionId,
          subSessionId,
          subAgentId: `SubAgent-${subagentType}`,
          taskSummary: description.slice(0, 60),
          turnCount: 0,
          elapsedMs: durationMs,
        });

        // Inject system notification into parent session so the agent becomes aware
        try {
          const { SessionManager } = await import('../../session/SessionManager.js');
          const sm = SessionManager.getInstance();
          const resultSummary = (result.content || '').slice(0, 500);
          const sysMsg: Message = {
            id: `sys-bg-${Date.now()}`,
            sessionId: ctx.sessionId,
            role: MessageRole.System,
            content: `[System notification] Background task completed in ${(durationMs / 1000).toFixed(1)}s: "${description}"\n\nResult summary: ${resultSummary || '(no output)'}\n\nUse TaskList to review all task statuses.`,
            tokenCount: 0,
            compressed: false,
            timestamp: new Date().toISOString(),
            agentId: ctx.agentId,
          };
          await sm.appendMessage(ctx.sessionId, sysMsg);
        } catch (sysErr) {
          logger.warn('Failed to inject background completion message', { sid: ctx.sessionId, error: (sysErr as Error).message });
        }
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;
        logger.error('Background SubAgent failed', { type: subagentType, error: errMsg, sid: ctx.sessionId });
        TypedEventBus.emit('delegation:error', {
          parentSessionId: ctx.sessionId,
          subSessionId: `subagent-err-${Date.now()}`,
          subAgentId: `SubAgent-${subagentType}`,
          taskSummary: description.slice(0, 60),
          elapsedMs: durationMs,
        });
      });

      return this.makeResult(
        `SubAgent spawned in background: ${description}\n` +
        `Type: ${subagentType}\n` +
        `Model: ${model}\n` +
        'The result will be delivered when complete via system notification.',
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
