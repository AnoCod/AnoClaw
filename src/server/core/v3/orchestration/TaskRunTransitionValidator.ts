import type {
  Run,
  RunStatus,
  Task,
  TaskReport,
  TaskStatus,
} from '../../../../shared/types/v3/index.js';

export type TransitionErrorCode =
  | 'invalid_transition'
  | 'report_required'
  | 'report_empty'
  | 'report_mismatch'
  | 'report_not_submitted'
  | 'max_turns_exhausted'
  | 'reviewer_required'
  | 'reviewer_must_differ'
  | 'verification_required';

export type TransitionDecision<T> =
  | { ok: true; value: T }
  | { ok: false; code: TransitionErrorCode; message: string };

export interface AgentLoopCompletion {
  taskStatus: 'submitted';
  runStatus: 'succeeded';
}

export interface VerificationStarted {
  taskStatus: 'verifying';
  reviewerAgentId: string;
}

export interface VerificationCompleted {
  taskStatus: 'completed';
}

export interface RevisionRequired {
  taskStatus: 'revision_required';
  nextAttempt: number;
}

export interface RevisionAttempt {
  taskStatus: 'ready';
  runStatus: 'queued';
  attempt: number;
}

export interface TaskTransitionEvidence {
  run?: Run;
  report?: TaskReport;
  reviewerAgentId?: string;
  verificationPassed?: boolean;
}

export interface RunTransitionEvidence {
  task?: Task;
  report?: TaskReport;
}

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['claimed', 'blocked', 'cancelled'],
  claimed: ['running', 'ready', 'blocked', 'cancelled'],
  running: ['submitted', 'blocked', 'failed', 'cancelled'],
  submitted: ['verifying', 'revision_required', 'cancelled'],
  verifying: ['completed', 'revision_required', 'cancelled'],
  revision_required: ['ready', 'cancelled'],
  blocked: ['ready', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'recovery_required'],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: [],
};

export class TaskRunTransitionValidator {
  validateTaskTransition(
    task: Task,
    nextStatus: TaskStatus,
    evidence: TaskTransitionEvidence = {},
  ): TransitionDecision<TaskStatus> {
    if (!isTaskTransitionAllowed(task, nextStatus)) {
      return invalidTransition('Task', task.status, nextStatus);
    }
    if (nextStatus === 'submitted') {
      if (!evidence.run) {
        return {
          ok: false,
          code: 'verification_required',
          message: 'Run evidence is required to submit a task.',
        };
      }
      const completion = this.completeAgentLoop(task, evidence.run, evidence.report);
      return completion.ok
        ? { ok: true, value: completion.value.taskStatus }
        : completion;
    }
    if (nextStatus === 'verifying') {
      if (!evidence.run) {
        return {
          ok: false,
          code: 'verification_required',
          message: 'Run evidence is required to begin verification.',
        };
      }
      const started = this.beginVerification(
        task,
        evidence.run,
        evidence.report,
        evidence.reviewerAgentId,
      );
      return started.ok ? { ok: true, value: started.value.taskStatus } : started;
    }
    if (nextStatus === 'completed' || nextStatus === 'revision_required') {
      if (!evidence.run || evidence.verificationPassed == null) {
        return {
          ok: false,
          code: 'verification_required',
          message: 'A completed verification decision is required.',
        };
      }
      if ((nextStatus === 'completed') !== evidence.verificationPassed) {
        return {
          ok: false,
          code: 'verification_required',
          message: 'Task status does not match the verification decision.',
        };
      }
      const completed = this.finishVerification(
        task,
        evidence.run,
        evidence.report,
        evidence.reviewerAgentId,
        evidence.verificationPassed,
      );
      return completed.ok ? { ok: true, value: completed.value.taskStatus } : completed;
    }
    return { ok: true, value: nextStatus };
  }

  validateRunTransition(
    run: Run,
    nextStatus: RunStatus,
    evidence: RunTransitionEvidence = {},
  ): TransitionDecision<RunStatus> {
    if (!isRunTransitionAllowed(run, nextStatus)) {
      return invalidTransition('Run', run.status, nextStatus);
    }
    if (nextStatus === 'succeeded') {
      if (!evidence.task) {
        return {
          ok: false,
          code: 'verification_required',
          message: 'Task evidence is required to succeed a run.',
        };
      }
      const completion = this.completeAgentLoop(evidence.task, run, evidence.report);
      return completion.ok ? { ok: true, value: completion.value.runStatus } : completion;
    }
    return { ok: true, value: nextStatus };
  }

  completeAgentLoop(
    task: Task,
    run: Run,
    report: TaskReport | undefined,
  ): TransitionDecision<AgentLoopCompletion> {
    if (!isTaskTransitionAllowed(task, 'submitted')) {
      return invalidTransition('Task', task.status, 'submitted');
    }
    if (!isRunTransitionAllowed(run, 'succeeded')) {
      return invalidTransition('Run', run.status, 'succeeded');
    }
    const reportDecision = validateReport(task, run, report);
    if (!reportDecision.ok) return reportDecision;
    if (run.terminationReason === 'max_turns') {
      return {
        ok: false,
        code: 'max_turns_exhausted',
        message: 'A run stopped by maxTurns cannot submit a task for verification.',
      };
    }
    if (run.terminationReason && run.terminationReason !== 'completed') {
      return {
        ok: false,
        code: 'verification_required',
        message: `Run termination reason ${run.terminationReason} cannot produce a submitted task.`,
      };
    }
    return {
      ok: true,
      value: {
        taskStatus: 'submitted',
        runStatus: 'succeeded',
      },
    };
  }

  beginVerification(
    task: Task,
    run: Run,
    report: TaskReport | undefined,
    reviewerAgentId: string | undefined,
  ): TransitionDecision<VerificationStarted> {
    if (!isTaskTransitionAllowed(task, 'verifying')) {
      return invalidTransition('Task', task.status, 'verifying');
    }
    if (run.status !== 'succeeded') {
      return invalidTransition('Run', run.status, 'succeeded');
    }
    const reportDecision = validateReport(task, run, report);
    if (!reportDecision.ok) return reportDecision;
    const reviewerDecision = validateReviewer(run, reviewerAgentId);
    if (!reviewerDecision.ok) return reviewerDecision;
    return {
      ok: true,
      value: {
        taskStatus: 'verifying',
        reviewerAgentId: reviewerDecision.value,
      },
    };
  }

  finishVerification(
    task: Task,
    run: Run,
    report: TaskReport | undefined,
    reviewerAgentId: string | undefined,
    approved: boolean,
  ): TransitionDecision<VerificationCompleted | RevisionRequired> {
    const nextStatus: TaskStatus = approved ? 'completed' : 'revision_required';
    if (!isTaskTransitionAllowed(task, nextStatus)) {
      return invalidTransition('Task', task.status, nextStatus);
    }
    if (run.status !== 'succeeded') {
      return invalidTransition('Run', run.status, 'succeeded');
    }
    const reportDecision = validateReport(task, run, report);
    if (!reportDecision.ok) return reportDecision;
    const reviewerDecision = validateReviewer(run, reviewerAgentId);
    if (!reviewerDecision.ok) return reviewerDecision;
    if (run.terminationReason === 'max_turns') {
      return {
        ok: false,
        code: 'max_turns_exhausted',
        message: 'A run stopped by maxTurns cannot complete a task.',
      };
    }
    if (approved) {
      return { ok: true, value: { taskStatus: 'completed' } };
    }
    return {
      ok: true,
      value: {
        taskStatus: 'revision_required',
        nextAttempt: run.attempt + 1,
      },
    };
  }

  prepareRevisionAttempt(
    task: Task,
    previousRun: Run,
  ): TransitionDecision<RevisionAttempt> {
    if (!isTaskTransitionAllowed(task, 'ready')) {
      return invalidTransition('Task', task.status, 'ready');
    }
    if (previousRun.status !== 'succeeded') {
      return invalidTransition('Run', previousRun.status, 'succeeded');
    }
    return {
      ok: true,
      value: {
        taskStatus: 'ready',
        runStatus: 'queued',
        attempt: previousRun.attempt + 1,
      },
    };
  }
}

function isTaskTransitionAllowed(task: Task, nextStatus: TaskStatus): boolean {
  return TASK_TRANSITIONS[task.status].includes(nextStatus);
}

function isRunTransitionAllowed(run: Run, nextStatus: RunStatus): boolean {
  return RUN_TRANSITIONS[run.status].includes(nextStatus);
}

function validateReport(
  task: Task,
  run: Run,
  report: TaskReport | undefined,
): TransitionDecision<TaskReport> {
  if (!report) {
    return {
      ok: false,
      code: 'report_required',
      message: 'A TaskReport is required.',
    };
  }
  const hasContent = report.summary.trim().length > 0
    || (report.details?.trim().length ?? 0) > 0
    || report.artifacts.some((artifact) => artifact.trim().length > 0);
  if (!hasContent) {
    return {
      ok: false,
      code: 'report_empty',
      message: 'TaskReport must contain a summary, details, or artifact.',
    };
  }
  if (
    report.taskId !== task.id
    || (report.runId != null && report.runId !== run.id)
    || report.agentId !== run.agentId
    || run.taskId !== task.id
  ) {
    return {
      ok: false,
      code: 'report_mismatch',
      message: 'TaskReport does not belong to this task, run, and worker.',
    };
  }
  if (report.outcome !== 'submitted' && report.outcome !== 'completed') {
    return {
      ok: false,
      code: 'report_not_submitted',
      message: `TaskReport outcome ${report.outcome} is not eligible for verification.`,
    };
  }
  return { ok: true, value: report };
}

function validateReviewer(
  run: Run,
  reviewerAgentId: string | undefined,
): TransitionDecision<string> {
  if (!reviewerAgentId?.trim()) {
    return {
      ok: false,
      code: 'reviewer_required',
      message: 'A reviewer is required.',
    };
  }
  if (reviewerAgentId === run.agentId) {
    return {
      ok: false,
      code: 'reviewer_must_differ',
      message: 'The reviewer must be distinct from the worker.',
    };
  }
  return { ok: true, value: reviewerAgentId };
}

function invalidTransition<T>(
  entity: 'Task' | 'Run',
  from: string,
  to: string,
): TransitionDecision<T> {
  return {
    ok: false,
    code: 'invalid_transition',
    message: `${entity} cannot transition from ${from} to ${to}.`,
  };
}
