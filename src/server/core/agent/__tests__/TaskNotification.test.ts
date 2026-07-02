/**
 * TaskNotification tests — XML construction and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { buildTaskNotificationXML, type TaskNotificationPayload } from '../TaskNotification.js';

const basePayload: TaskNotificationPayload = {
  taskId: 'abc12345',
  status: 'completed',
  type: 'subagent',
  summary: 'Generated unit tests for ToolPipeline',
  result: 'Created 15 test cases. All passing.',
  durationMs: 4200,
  turnCount: 3,
};

describe('buildTaskNotificationXML', () => {
  it('generates valid XML with all fields', () => {
    const xml = buildTaskNotificationXML(basePayload);

    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('</task-notification>');
    expect(xml).toContain('<task-id>abc12345</task-id>');
    expect(xml).toContain('<status>completed</status>');
    expect(xml).toContain('<type>subagent</type>');
    expect(xml).toContain('<summary>Generated unit tests for ToolPipeline</summary>');
    expect(xml).toContain('<result>');
    expect(xml).toContain('Created 15 test cases. All passing.');
    expect(xml).toContain('</result>');
    expect(xml).toContain('<duration-ms>4200</duration-ms>');
    expect(xml).toContain('<turn-count>3</turn-count>');
  });

  it('omits turn-count when undefined', () => {
    const payload: TaskNotificationPayload = {
      taskId: 'x1',
      status: 'failed',
      type: 'bash',
      summary: 'Build failed',
      result: 'exit code 1',
      durationMs: 100,
    };
    const xml = buildTaskNotificationXML(payload);

    expect(xml).not.toContain('<turn-count>');
  });

  it('truncates result to 2000 characters', () => {
    const longResult = 'A'.repeat(3000);
    const payload: TaskNotificationPayload = {
      taskId: 'x2',
      status: 'killed',
      type: 'command',
      summary: 'Long output',
      result: longResult,
      durationMs: 500,
    };
    const xml = buildTaskNotificationXML(payload);

    // The result tag should contain only 2000 chars, not 3000
    const resultMatch = xml.match(/<result>\n([\s\S]*?)\n<\/result>/);
    expect(resultMatch).not.toBeNull();
    expect(resultMatch![1].length).toBe(2000);
    expect(resultMatch![1]).toBe('A'.repeat(2000));
  });

  it('handles empty result', () => {
    const payload: TaskNotificationPayload = {
      taskId: 'x3',
      status: 'failed',
      type: 'subagent',
      summary: 'Empty result test',
      result: '',
      durationMs: 0,
    };
    const xml = buildTaskNotificationXML(payload);

    expect(xml).toContain('<result>\n\n</result>');
  });

  it('handles failed status with error in result', () => {
    const payload: TaskNotificationPayload = {
      taskId: 'err1',
      status: 'failed',
      type: 'bash',
      summary: 'Command errored',
      result: 'Error: permission denied',
      durationMs: 200,
    };
    const xml = buildTaskNotificationXML(payload);

    expect(xml).toContain('<status>failed</status>');
    expect(xml).toContain('Error: permission denied');
  });

  it('handles killed status', () => {
    const payload: TaskNotificationPayload = {
      taskId: 'kill1',
      status: 'killed',
      type: 'subagent',
      summary: 'User stopped task',
      result: 'Interrupted by user',
      durationMs: 1500,
      turnCount: 1,
    };
    const xml = buildTaskNotificationXML(payload);

    expect(xml).toContain('<status>killed</status>');
    expect(xml).toContain('<turn-count>1</turn-count>');
  });

  it('escapes XML-like content in result gracefully (plain text pass-through)', () => {
    const payload: TaskNotificationPayload = {
      taskId: 'xml1',
      status: 'completed',
      type: 'subagent',
      summary: 'XML-like content',
      result: '<div>Hello</div>',
      durationMs: 10,
    };
    const xml = buildTaskNotificationXML(payload);

    // The result contains the raw text (agent parsing handles the nesting)
    expect(xml).toContain('<div>Hello</div>');
  });
});
