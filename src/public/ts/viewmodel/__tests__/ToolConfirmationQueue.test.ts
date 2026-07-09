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

  it('exposes a waiting snapshot while a confirmation is active', async () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    const changes: number[] = [];
    const showSpy = vi.spyOn(ToolConfirmDialog, 'show').mockResolvedValue(true);

    queue.setSender(send);
    queue.onChange(() => changes.push(queue.snapshot.count));

    queue.enqueue({
      sessionId: 'regular-session',
      toolCallId: 'tc-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'npm test -- --runInBand', timeout: 120000 },
    });

    expect(showSpy).toHaveBeenCalledOnce();
    expect(queue.snapshot).toMatchObject({
      count: 1,
      first: {
        toolCallId: 'tc-bash',
        toolName: 'Bash',
        displayName: 'Bash',
        riskLevel: 'High',
        sessionId: 'regular-session',
      },
    });
    expect(queue.snapshot.first?.detail).toContain('command:');

    await Promise.resolve();
    await Promise.resolve();

    expect(queue.snapshot).toEqual({ count: 0, first: null });
    expect(changes).toContain(1);
    expect(changes[changes.length - 1]).toBe(0);
    expect(send).toHaveBeenCalledWith({
      type: 'tool_confirm_response',
      toolCallId: 'tc-bash',
      approved: true,
    });
  });

  it('allows inline resolving a low-risk active confirmation', async () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    vi.spyOn(ToolConfirmDialog, 'show').mockImplementation(() => new Promise<boolean>(() => {}));

    queue.setSender(send);
    queue.enqueue({
      sessionId: 'regular-session',
      toolCallId: 'tc-edit',
      toolName: 'Edit',
      displayName: 'Edit',
      riskLevel: 'Low',
      params: { file_path: 'src/app.ts' },
    });

    expect(queue.snapshot.first?.canInlineResolve).toBe(true);
    expect(queue.respondToFirst(true, 'tc-edit')).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith({
      type: 'tool_confirm_response',
      toolCallId: 'tc-edit',
      approved: true,
    });
    expect(queue.snapshot).toEqual({ count: 0, first: null });
  });

  it('does not inline-approve high-risk confirmations', async () => {
    const queue = ToolConfirmationQueue.getInstance();
    const send = vi.fn();
    vi.spyOn(ToolConfirmDialog, 'show').mockImplementation(() => new Promise<boolean>(() => {}));

    queue.setSender(send);
    queue.enqueue({
      sessionId: 'regular-session',
      toolCallId: 'tc-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'rm -rf dist' },
    });

    expect(queue.snapshot.first?.canInlineResolve).toBe(false);
    expect(queue.respondToFirst(true, 'tc-bash')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queue.snapshot.count).toBe(1);
  });
});
