import type { ExecutionContext, GoalEvidence, GoalReportOutcome } from '../../../../shared/types/session.js';
import { RiskLevel } from '../../../../shared/types/tool.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';
import { WsServer } from '../../../infra/network/WsServer.js';
import { SessionManager } from '../../session/SessionManager.js';
import { Tool } from '../Tool.js';
import * as path from 'node:path';

const OUTCOMES = new Set<GoalReportOutcome>([
  'progress',
  'waiting_user',
  'waiting_review',
  'blocked',
  'failed',
]);

export class GoalReportTool extends Tool {
  static category = 'Goal';
  static toolDescription = 'Submit the required structured outcome for the current Goal run.';

  name(): string { return 'GoalReport'; }

  displayName(): string { return 'Goal Run Report'; }

  description(): string {
    return 'Report the outcome of the current Goal run. Every autonomous Goal run must call this exactly once before finishing.';
  }

  prompt(): string {
    return [
      'Use GoalReport exactly once before ending an autonomous Goal run.',
      'Use progress only when concrete work or verification was completed and another run is useful.',
      'Use waiting_review when the acceptance criteria appear satisfied; the user will decide whether to accept completion.',
      'Include Workspace files, images, tests, URLs, or notes as evidence when they support the outcome.',
    ].join(' ');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1, description: 'Current Goal run ID from the execution prompt.' },
        outcome: {
          type: 'string',
          enum: [...OUTCOMES],
          description: 'Structured outcome for this run.',
        },
        summary: { type: 'string', minLength: 1, maxLength: 4000, description: 'Concrete work completed in this run.' },
        nextStep: { type: 'string', maxLength: 2000, description: 'Next useful action when more work remains.' },
        reason: { type: 'string', maxLength: 2000, description: 'Why the run is waiting, blocked, or failed.' },
        progress: { type: 'number', minimum: 0, maximum: 100, description: 'Optional evidence-based progress estimate.' },
        evidence: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'image', 'test', 'url', 'note'] },
              label: { type: 'string', minLength: 1, maxLength: 300 },
              path: { type: 'string', maxLength: 2000 },
              url: { type: 'string', maxLength: 2000 },
              detail: { type: 'string', maxLength: 2000 },
            },
            required: ['type', 'label'],
            additionalProperties: false,
          },
        },
      },
      required: ['runId', 'outcome', 'summary'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return false; }
  shouldDefer(): boolean { return true; }
  minRole(): string { return 'MainAgent'; }
  maxRetries(): number { return 0; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext) {
    const runId = typeof params.runId === 'string' ? params.runId.trim() : '';
    const outcome = typeof params.outcome === 'string' ? params.outcome as GoalReportOutcome : undefined;
    const summary = typeof params.summary === 'string' ? params.summary.trim() : '';
    if (!runId) return this.makeError('runId is required');
    if (!outcome || !OUTCOMES.has(outcome)) return this.makeError('outcome is invalid');
    if (!summary) return this.makeError('summary is required');

    const sessionManager = SessionManager.getInstance();
    const current = sessionManager.getGoal(ctx.sessionId);
    if (!current) return this.makeError('No active Goal exists for this session');
    if (current.status !== 'active') return this.makeError(`Goal is not running (status: ${current.status})`);
    if (current.currentRunId !== runId) return this.makeError('runId does not match the active Goal run');
    const evidence = Array.isArray(params.evidence) ? params.evidence as GoalEvidence[] : undefined;
    const workspaceRoot = path.resolve(current.workspace || ctx.workspace || '.');
    for (const item of evidence || []) {
      if (!item?.path) continue;
      const resolved = path.resolve(workspaceRoot, item.path);
      if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
        return this.makeError(`Evidence path must stay inside the Goal Workspace: ${item.path}`);
      }
    }

    const goal = await sessionManager.reportGoalRun(ctx.sessionId, {
      runId,
      outcome,
      summary,
      nextStep: typeof params.nextStep === 'string' ? params.nextStep : undefined,
      reason: typeof params.reason === 'string' ? params.reason : undefined,
      progress: typeof params.progress === 'number' ? params.progress : undefined,
      evidence,
    });
    if (!goal) return this.makeError('Goal no longer exists');

    const root = sessionManager.getRootSession(ctx.sessionId);
    WsServer.getInstance().send(root.id, {
      type: WsMessageType.GoalChanged,
      sessionId: root.id,
      action: 'report',
      goal,
    });

    return this.makeResult(`Goal run reported: ${goal.status}. ${goal.lastSummary || ''}`.trim(), {
      structured: { goal },
    });
  }
}
