import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolConfirmDialog } from '../../components/ToolConfirmDialog.js';
import { ToolConfirmationQueue } from '../ToolConfirmationQueue.js';

afterEach(() => {
  vi.restoreAllMocks();
  ToolConfirmationQueue.resetInstance();
});

describe('ToolConfirmationQueue', () => {
  it('auto-approves confirmations when the current goal policy allows it', () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    const showSpy = vi.spyOn(ToolConfirmDialog, 'show');

    queue.setSender(send);
    queue.setAutoApprover((request) => request.sessionId === 'goal-session');

    queue.enqueue({
      sessionId: 'goal-session',
      toolCallId: 'tc-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'npm test' },
    });

    expect(showSpy).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'tool_confirm_response',
      toolCallId: 'tc-bash',
      approved: true,
    });
  });

  it('auto-approves confirmations when the server already marked the request safe for goal mode', () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    const showSpy = vi.spyOn(ToolConfirmDialog, 'show');

    queue.setSender(send);
    queue.setAutoApprover(() => false);

    queue.enqueue({
      sessionId: 'goal-session',
      toolCallId: 'tc-auto-approved-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'npm test' },
      autoApprove: true,
    });

    expect(showSpy).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: 'tool_confirm_response',
      toolCallId: 'tc-auto-approved-bash',
      approved: true,
    });
  });

  it('shows the normal dialog outside auto-approved goal sessions', async () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    const showSpy = vi.spyOn(ToolConfirmDialog, 'show').mockResolvedValue(false);

    queue.setSender(send);
    queue.setAutoApprover((request) => request.sessionId === 'goal-session');

    queue.enqueue({
      sessionId: 'regular-session',
      toolCallId: 'tc-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'npm test' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(showSpy).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'tool_confirm_response',
      toolCallId: 'tc-bash',
      approved: false,
    });
  });
});
