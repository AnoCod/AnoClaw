import type { SessionTranscriptRecord, Task, WorkProjection } from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  assertTaskInTeam,
  booleanValue,
  optionalInteger,
  requiredText,
  requireScopedState,
  v3WorkToolDependencies,
  V3WorkToolError,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

export class TaskOutputTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Reads persistent Task reports, verification evidence, and Run transcripts.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskOutput'; }
  description(): string {
    return 'Read durable output and transcript evidence for one Team Task, optionally waiting for its next report or terminal state.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000 },
        maxChars: { type: 'integer', minimum: 200, maximum: 50_000 },
      },
      required: ['taskId'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      let projection = state.work;
      let task = projection.tasks[taskId];
      if (!task) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
      assertTaskInTeam(
        task,
        state.context.teamId,
        state.company,
        state.context.agentId,
      );

      if (booleanValue(params.wait, false) && !hasDurableOutput(task, projection)) {
        await waitForTaskOutput(
          dependencies,
          state.context.workId,
          taskId,
          optionalInteger(params.timeoutMs, 'timeoutMs', 100, 60_000) ?? 30_000,
        );
        projection = await dependencies.workRepository.getProjection(state.context.workId);
        task = projection.tasks[taskId] ?? task;
      }

      const runs = Object.values(projection.runs)
        .filter((run) => run.taskId === taskId)
        .sort((left, right) => left.attempt - right.attempt);
      const reports = Object.values(projection.taskReports)
        .filter((report) => report.taskId === taskId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const verifications = Object.values(projection.verificationRecords)
        .filter((record) => record.taskId === taskId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const transcripts: Array<{
        sessionId: string;
        entries: SessionTranscriptRecord[];
      }> = [];
      for (const run of runs) {
        transcripts.push({
          sessionId: run.sessionId,
          entries: await dependencies.transcriptRepository.read(run.sessionId),
        });
      }
      const maxChars = optionalInteger(params.maxChars, 'maxChars', 200, 50_000) ?? 4_000;
      const transcriptText = transcripts
        .flatMap(({ sessionId, entries }) => entries.map((record) => {
          if (record.entry.kind === 'message') {
            if (record.entry.role !== 'assistant' && record.entry.role !== 'tool') return '';
            return `[${sessionId}/${record.entry.role}] ${record.entry.content}`;
          }
          return `[${sessionId}/event:${record.entry.eventType}] ${JSON.stringify(record.entry.data)}`;
        }))
        .filter(Boolean)
        .slice(-100)
        .join('\n');
      const latestReport = reports.at(-1);
      const latestRun = runs.at(-1);
      const rendered = truncateMiddle(
        transcriptText
          || latestReport?.details
          || latestReport?.summary
          || latestRun?.resultSummary
          || latestRun?.error
          || '(no durable output yet)',
        maxChars,
      );
      return this.makeResult(
        `${task.id} is ${task.status}.\nSummary: ${latestReport?.summary ?? latestRun?.resultSummary ?? task.title}\nOutput: ${rendered}`,
        {
          structured: {
            task,
            runs,
            reports,
            verifications,
            output: rendered,
            transcriptRefs: transcripts.map(({ sessionId, entries }) => ({
              sessionId,
              sequence: entries.at(-1)?.sequence ?? 0,
            })),
          },
        },
      );
    } catch (error) {
      return workToolFailure(error);
    }
  }
}

function hasDurableOutput(task: Task, projection: WorkProjection): boolean {
  return ['submitted', 'verifying', 'revision_required', 'completed', 'failed', 'cancelled']
    .includes(task.status)
    || Object.values(projection.taskReports).some((report) => report.taskId === task.id);
}

function waitForTaskOutput(
  dependencies: V3WorkToolDependencies,
  workId: string,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dependencies.workRepository.off('changed', onChange);
      resolve();
    };
    const onChange = (change: { workId: string }) => {
      if (change.workId !== workId) return;
      void dependencies.workRepository.getProjection(workId)
        .then((projection) => {
          const task = projection.tasks[taskId];
          if (task && hasDurableOutput(task, projection)) done();
        })
        .catch(done);
    };
    dependencies.workRepository.on('changed', onChange);
    const timer = setTimeout(done, timeoutMs);
  });
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 40) / 2);
  return `${value.slice(0, side)}\n...[truncated ${value.length - side * 2} chars]...\n${value.slice(-side)}`;
}
