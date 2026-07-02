/**
 * TaskNotification — builds <task-notification> XML for agent consumption.
 *
 * Mirrors Claude Code's format: <task-notification> XML block injected as
 * a user-role message so the agent processes it as conversational input
 * (not a system event).
 *
 * @module TaskNotification
 */

export interface TaskNotificationPayload {
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  type: string;
  summary: string;
  result: string;
  durationMs: number;
  turnCount?: number;
}

export function buildTaskNotificationXML(payload: TaskNotificationPayload): string {
  const lines = [
    '<task-notification>',
    `<task-id>${payload.taskId}</task-id>`,
    `<status>${payload.status}</status>`,
    `<type>${payload.type}</type>`,
    `<summary>${payload.summary}</summary>`,
    `<duration-ms>${payload.durationMs}</duration-ms>`,
    payload.turnCount !== undefined ? `<turn-count>${payload.turnCount}</turn-count>` : undefined,
    '<result>',
    payload.result.slice(0, 2000),
    '</result>',
    '</task-notification>',
  ];
  return lines.filter((l): l is string => l !== undefined).join('\n');
}
