import { describe, expect, it } from 'vitest';
import type {
  Run,
  RunStatus,
  Task,
  TaskReport,
  TaskStatus,
} from '../../../../../shared/types/v3/index.js';
import { TaskRunTransitionValidator } from '../TaskRunTransitionValidator.js';

describe('TaskRunTransitionValidator', () => {
  const validator = new TaskRunTransitionValidator();

  it('enforces AgentLoop Done then independent verification before completion', () => {
    const runningTask = task('running');
    const runningRun = run('running');
    const submittedReport = report();

    expect(validator.completeAgentLoop(runningTask, runningRun, submittedReport)).toEqual({
      ok: true,
      value: {
        taskStatus: 'submitted',
        runStatus: 'succeeded',
      },
    });

    const submittedTask = task('submitted');
    const succeededRun = run('succeeded');
    expect(validator.beginVerification(
      submittedTask,
      succeededRun,
      submittedReport,
      'reviewer',
    )).toEqual({
      ok: true,
      value: {
        taskStatus: 'verifying',
        reviewerAgentId: 'reviewer',
      },
    });

    expect(validator.finishVerification(
      task('verifying'),
      succeededRun,
      submittedReport,
      'reviewer',
      true,
    )).toEqual({
      ok: true,
      value: { taskStatus: 'completed' },
    });
  });

  it('rejects missing and empty reports', () => {
    expect(validator.completeAgentLoop(task('running'), run('running'), undefined))
      .toMatchObject({ ok: false, code: 'report_required' });
    expect(validator.completeAgentLoop(
      task('running'),
      run('running'),
      report({ summary: '   ', details: ' ', artifacts: [] }),
    )).toMatchObject({ ok: false, code: 'report_empty' });
  });

  it('never completes a run that stopped at maxTurns', () => {
    const exhausted = run('running', {
      terminationReason: 'max_turns',
      turnsConsumed: 10,
      maxTurns: 10,
    });
    expect(validator.completeAgentLoop(task('running'), exhausted, report()))
      .toMatchObject({ ok: false, code: 'max_turns_exhausted' });

    expect(validator.finishVerification(
      task('verifying'),
      { ...exhausted, status: 'succeeded' },
      report(),
      'reviewer',
      true,
    )).toMatchObject({ ok: false, code: 'max_turns_exhausted' });
  });

  it('requires a reviewer distinct from the worker', () => {
    expect(validator.beginVerification(
      task('submitted'),
      run('succeeded'),
      report(),
      undefined,
    )).toMatchObject({ ok: false, code: 'reviewer_required' });
    expect(validator.beginVerification(
      task('submitted'),
      run('succeeded'),
      report(),
      'worker',
    )).toMatchObject({ ok: false, code: 'reviewer_must_differ' });
  });

  it('returns revision_required and reserves a new attempt after failed verification', () => {
    const succeededRun = run('succeeded', { attempt: 3 });
    expect(validator.finishVerification(
      task('verifying'),
      succeededRun,
      report(),
      'reviewer',
      false,
    )).toEqual({
      ok: true,
      value: {
        taskStatus: 'revision_required',
        nextAttempt: 4,
      },
    });

    expect(validator.prepareRevisionAttempt(task('revision_required'), succeededRun)).toEqual({
      ok: true,
      value: {
        taskStatus: 'ready',
        runStatus: 'queued',
        attempt: 4,
      },
    });
  });

  it('rejects attempts to skip required states', () => {
    expect(validator.validateTaskTransition(task('running'), 'completed'))
      .toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(validator.validateTaskTransition(task('running'), 'submitted'))
      .toMatchObject({ ok: false, code: 'verification_required' });
    expect(validator.validateTaskTransition(task('verifying'), 'completed'))
      .toMatchObject({ ok: false, code: 'verification_required' });
    expect(validator.validateRunTransition(run('running'), 'succeeded'))
      .toMatchObject({ ok: false, code: 'verification_required' });
    expect(validator.finishVerification(
      task('submitted'),
      run('succeeded'),
      report(),
      'reviewer',
      true,
    )).toMatchObject({ ok: false, code: 'invalid_transition' });
  });
});

function task(status: TaskStatus): Task {
  return {
    id: 'task-1',
    workId: 'work-1',
    missionId: 'mission-1',
    title: 'Implement',
    acceptanceCriteria: ['Implemented'],
    status,
    priority: 'normal',
    assignedAgentId: 'worker',
    dependsOnTaskIds: [],
    readOnly: false,
    writeScope: [],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function run(status: RunStatus, overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    workId: 'work-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    agentId: 'worker',
    sessionId: 'session-1',
    status,
    attempt: 1,
    maxTurns: 10,
    turnsConsumed: 3,
    fencingToken: overrides.fencingToken ?? 1,
    tokenUsage: overrides.tokenUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    cost: overrides.cost ?? { currency: 'USD', amount: 0, estimated: true },
    toolCount: overrides.toolCount ?? 0,
    workspaceExecution: overrides.workspaceExecution ?? { mode: 'none' },
    terminationReason: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function report(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    id: 'report-1',
    taskId: 'task-1',
    runId: 'run-1',
    agentId: 'worker',
    outcome: 'submitted',
    summary: 'Implemented and tested.',
    artifacts: ['commit:abc123'],
    createdAt: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}
