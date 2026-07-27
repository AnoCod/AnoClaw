import { describe, expect, it } from 'vitest';
import {
  parseCoordinationEnvelope,
  parseInterruptNotice,
} from '../CoordinationPresentation.js';

describe('parseCoordinationEnvelope', () => {
  it('turns a durable note into a mailbox-only presentation without raw XML', () => {
    const parsed = parseCoordinationEnvelope([
      '<coordination-message id="msg-1" root-session-id="root-1" from-agent="ceo" to-agent="frontend-manager" session-id="sub-1" kind="note">',
      'Hey, 我是 CEO。Frontend Team 最近在做什么？',
      '</coordination-message>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      envelopeType: 'message',
      state: 'mailbox_only',
      statusLabel: 'Delivered · mailbox only',
      fromAgentId: 'ceo',
      toAgentId: 'frontend-manager',
      body: 'Hey, 我是 CEO。Frontend Team 最近在做什么？',
    });
    expect(parsed?.body).not.toContain('<coordination-message');
  });

  it('shows a workspace conflict as waiting for workspace instead of busy', () => {
    const parsed = parseCoordinationEnvelope([
      '<coordination-event message-id="msg-2" root-session-id="root-1" task-id="task-1" from-agent="worker" to-agent="ceo" kind="task_update">',
      'Summary: CEO 找你聊天 - 请回复: blocked',
      'Task task-1 is blocked.',
      'Blocker: workspace_conflict',
      '</coordination-event>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      envelopeType: 'event',
      state: 'waiting_workspace',
      tone: 'pending',
      heading: 'CEO 找你聊天 - 请回复',
      statusLabel: 'Waiting for workspace',
      taskId: 'task-1',
    });
  });

  it('keeps mailbox-only semantics when a note is injected into another session as an event', () => {
    const parsed = parseCoordinationEnvelope([
      '<coordination-event message-id="msg-3" root-session-id="root-1" from-agent="ceo" to-agent="frontend-manager" kind="note">',
      'Review the latest status.',
      '</coordination-event>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      envelopeType: 'event',
      state: 'mailbox_only',
      statusLabel: 'Delivered · mailbox only',
      body: 'Review the latest status.',
    });
  });

  it.each([
    ['completed', 'completed', 'Task completed'],
    ['failed', 'failed', 'Task failed'],
    ['cancelled', 'cancelled', 'Task cancelled'],
  ] as const)('maps task result status %s', (status, state, statusLabel) => {
    const parsed = parseCoordinationEnvelope([
      `<coordination-event root-session-id="root-1" task-id="task-1" from-agent="worker" to-agent="ceo" status="${status}">`,
      'Subject: Focused verification',
      'Result: Evidence retained.',
      '</coordination-event>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      state,
      heading: 'Focused verification',
      statusLabel,
      body: 'Result: Evidence retained.',
    });
  });

  it('trusts an explicit terminal status over incidental words in a result', () => {
    const parsed = parseCoordinationEnvelope([
      '<coordination-event task-id="task-1" status="completed">',
      'Subject: Repair failed checks',
      'Result: The previously failed checks now pass.',
      '</coordination-event>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      state: 'completed',
      statusLabel: 'Task completed',
    });
  });

  it('presents a task packet as assigned and removes nested wrapper tags', () => {
    const parsed = parseCoordinationEnvelope([
      '<coordination-task task-id="task-7">',
      'Goal: Verify the frontend',
      'Assignment: Run focused tests',
      'Relevant parent context:',
      '- <coordination-event kind="task_update">Task task-6 is blocked.</coordination-event>',
      '</coordination-task>',
    ].join('\n'));

    expect(parsed).toMatchObject({
      envelopeType: 'task',
      state: 'assigned',
      heading: 'Run focused tests',
      statusLabel: 'Assigned · waiting to run',
      taskId: 'task-7',
    });
    expect(parsed?.body).toContain('Task task-6 is blocked.');
    expect(parsed?.body).not.toContain('<coordination-event');
  });
});

describe('parseInterruptNotice', () => {
  it.each([
    ['(Agent cancelled its own task)', 'task_self_cancel', 'Cancelled by this agent'],
    ['(Task cancelled by its creator)', 'task_creator_cancel', 'Cancelled by task creator'],
    ['(Task cancelled by the team coordinator)', 'task_coordinator_cancel', 'Cancelled by team coordinator'],
    ['(User stopped)', 'user_stop', 'Stopped by user'],
    ['(Parent session stopped)', 'parent_stop', 'Parent session stopped'],
  ] as const)('distinguishes %s', (content, reason, statusLabel) => {
    expect(parseInterruptNotice(content)).toMatchObject({ reason, statusLabel });
  });

  it('keeps backward compatibility for persisted interruption markers', () => {
    expect(parseInterruptNotice('[Request interrupted: user_stop]')).toMatchObject({
      reason: 'user_stop',
      statusLabel: 'Stopped by user',
    });
    expect(parseInterruptNotice('A normal assistant reply')).toBeNull();
  });
});
