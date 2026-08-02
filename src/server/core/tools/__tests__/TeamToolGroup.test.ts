import { describe, expect, it } from 'vitest';
import { toolRequiresConfirmation } from '../../agent/PermissionModePolicy.js';
import { RiskLevel } from '../Tool.js';
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';
import { OrganizationTool } from '../builtin/OrganizationTool.js';
import { TaskTool } from '../builtin/TaskTool.js';
import { TeamTool } from '../builtin/TeamTool.js';

function actionNames(tool: { parametersSchema(): Record<string, unknown> }): string[] {
  const schema = tool.parametersSchema() as {
    properties: { action: { enum: string[] } };
  };
  return schema.properties.action.enum;
}

describe('simplified coordination tool surface', () => {
  it('exposes four public tools instead of one tool per operation', () => {
    expect([OrganizationTool, TeamTool, AgentMessageTool].map((toolClass) => toolClass.category))
      .toEqual(Array(3).fill('Agent Teams'));
    expect(TaskTool.category).toBe('Task Coordination');
  });

  it('routes organization and team operations through action enums', () => {
    const organization = new OrganizationTool();
    const team = new TeamTool();

    expect(actionNames(organization)).toEqual(['list', 'hire', 'reassign']);
    expect(actionNames(team)).toEqual(['create', 'update', 'status', 'delete']);
    expect(organization.riskLevel({ action: 'list' })).toBe(RiskLevel.Safe);
    expect(organization.riskLevel({ action: 'hire' })).toBe(RiskLevel.High);
    expect(team.riskLevel({ action: 'status' })).toBe(RiskLevel.Safe);
    expect(team.riskLevel({ action: 'delete' })).toBe(RiskLevel.High);
  });

  it('removes redundant task get and folds temporary spawning into Task', () => {
    const task = new TaskTool();

    expect(actionNames(task)).toEqual([
      'create',
      'assign',
      'claim',
      'update',
      'list',
      'output',
      'stop',
      'spawn',
    ]);
    expect(task.riskLevel({ action: 'list' })).toBe(RiskLevel.Safe);
    expect(task.riskLevel({ action: 'create' })).toBe(RiskLevel.Low);
    expect(task.riskLevel({ action: 'stop' })).toBe(RiskLevel.High);
    expect(toolRequiresConfirmation('Auto', task, { action: 'list' })).toBe(false);
    expect(toolRequiresConfirmation('Auto', task, { action: 'stop' })).toBe(true);
  });

  it('makes mailbox, read-only task, and cancellation semantics explicit', () => {
    const messagePrompt = new AgentMessageTool().prompt();
    const taskPrompt = new TaskTool().prompt();

    expect(messagePrompt).toContain('mailbox-only');
    expect(messagePrompt).toContain('readOnly=true');
    expect(taskPrompt).toContain('defaults to read-only');
    expect(taskPrompt).toContain('stop only cancels unfinished work');
  });
});
