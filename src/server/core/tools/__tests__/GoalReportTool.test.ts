import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../session/SessionManager.js';
import { SessionStore } from '../../session/SessionStore.js';
import { GoalReportTool } from '../builtin/GoalReportTool.js';

describe('GoalReportTool', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-goal-report-'));
    (SessionManager as any)._instance = undefined;
    (SessionStore as any)._instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('moves a running goal to review and records evidence', async () => {
    const session = await manager.createMainSession('main-agent', 'Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Ship a report', acceptanceCriteria: 'report exists' });
    const running = await manager.beginGoalRun(session.id);
    const tool = new GoalReportTool();

    const result = await tool.execute({
      runId: running!.currentRunId,
      outcome: 'waiting_review',
      summary: 'Report created',
      progress: 100,
      evidence: [{ type: 'file', label: 'Report', path: 'report.md' }],
    }, {
      sessionId: session.id,
      agentId: 'main-agent',
      workspace: tmpDir,
      userConfirmed: true,
    });

    expect(result.success).toBe(true);
    expect(manager.getGoal(session.id)?.status).toBe('waiting_review');
    expect(manager.getGoal(session.id)?.evidence?.[0]?.path).toBe('report.md');
  });

  it('rejects stale run IDs', async () => {
    const session = await manager.createMainSession('main-agent', 'Goal', tmpDir);
    await manager.setGoal(session.id, 'Ship a report');
    await manager.beginGoalRun(session.id);

    const result = await new GoalReportTool().execute({
      runId: 'stale-run',
      outcome: 'progress',
      summary: 'Not valid',
    }, {
      sessionId: session.id,
      agentId: 'main-agent',
      workspace: tmpDir,
      userConfirmed: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('runId');
  });

  it('rejects evidence paths outside the bound Workspace', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    await fsp.mkdir(workspace);
    const session = await manager.createMainSession('main-agent', 'Goal', workspace);
    await manager.setGoal(session.id, 'Ship a report');
    const running = await manager.beginGoalRun(session.id);

    const result = await new GoalReportTool().execute({
      runId: running!.currentRunId,
      outcome: 'progress',
      summary: 'Invalid evidence',
      evidence: [{ type: 'file', label: 'Outside', path: '../outside.txt' }],
    }, {
      sessionId: session.id,
      agentId: 'main-agent',
      workspace,
      userConfirmed: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Workspace');
  });

  it('does not allow an agent to fabricate a confirmation wait state', async () => {
    const session = await manager.createMainSession('main-agent', 'Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Need approval', acceptanceCriteria: 'approved result' });
    const running = await manager.beginGoalRun(session.id);

    const result = await new GoalReportTool().execute({
      runId: running!.currentRunId,
      outcome: 'waiting_confirmation',
      summary: 'Pretending to wait',
    }, {
      sessionId: session.id,
      agentId: 'main-agent',
      workspace: tmpDir,
      userConfirmed: true,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('outcome is invalid');
    expect(manager.getGoal(session.id)?.status).toBe('active');
  });
});
