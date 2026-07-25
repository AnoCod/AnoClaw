import type { Message } from '../../../shared/types/session.js';
import type {
  CoordinationTask,
  TaskPacket,
} from '../../../shared/types/coordination.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { SessionManager } from '../session/SessionManager.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { CoordinationService } from './CoordinationService.js';

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 4_000;

export async function buildTaskPacket(task: CoordinationTask): Promise<TaskPacket> {
  const sessionManager = SessionManager.getInstance();
  const root = sessionManager.getRootSession(task.rootSessionId);
  const history = await sessionManager.getHistory(task.sourceSessionId)
    .catch(() => sessionManager.getHistory(root.id))
    .catch(() => [] as Message[]);
  const agent = task.assigneeAgentId
    ? AgentRegistry.getInstance().findAgent(task.assigneeAgentId)
    : undefined;
  const team = task.teamId
    ? CoordinationService.getInstance().getTeam(task.rootSessionId, task.teamId)
    : undefined;
  const dependencyResults = task.dependsOn.flatMap((dependencyId) => {
    const dependency = CoordinationService.getInstance().getTask(task.rootSessionId, dependencyId);
    if (!dependency) return [];
    return [{
      taskId: dependency.id,
      subject: dependency.subject,
      resultSummary: dependency.resultSummary,
      outputRef: dependency.outputRef,
      evidence: dependency.evidence,
    }];
  });

  return {
    taskId: task.id,
    rootSessionId: task.rootSessionId,
    teamId: task.teamId,
    sourceSessionId: task.sourceSessionId,
    sourceAgentId: task.creatorAgentId,
    goal: root.metadata.goal && typeof root.metadata.goal === 'object'
      ? String((root.metadata.goal as { objective?: unknown }).objective || task.subject)
      : task.subject,
    description: task.description,
    acceptanceCriteria: [...task.acceptanceCriteria],
    constraints: [
      task.readOnly
        ? 'This task is read-only. Do not invoke workspace-mutating tools.'
        : `Writes are limited to: ${task.writeScope.join(', ')}`,
      'Report verification evidence and any remaining risk.',
    ],
    parentContext: summarizeHistory(history),
    dependencyResults,
    workspace: root.workspace,
    teamRoster: team ? [...team.memberAgentIds] : [],
    readOnly: task.readOnly,
    writeScope: [...task.writeScope],
    allowedTools: agent
      ? ToolRegistry.getInstance().toolsForAgent(agent.allowedTools()).map((tool) => tool.name())
      : [],
  };
}

export function renderTaskPacket(packet: TaskPacket): string {
  const lines = [
    `<coordination-task task-id="${escapeAttribute(packet.taskId)}">`,
    `Goal: ${packet.goal}`,
    `Assignment: ${packet.description}`,
    'Acceptance criteria:',
    ...packet.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Constraints:',
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    `Workspace: ${packet.workspace}`,
    `Write scope: ${packet.readOnly ? '(read-only)' : packet.writeScope.join(', ')}`,
  ];
  if (packet.parentContext.length > 0) {
    lines.push('Relevant parent context:', ...packet.parentContext.map((entry) => `- ${entry}`));
  }
  if (packet.dependencyResults.length > 0) {
    lines.push('Completed dependency results:');
    for (const result of packet.dependencyResults) {
      lines.push(`- ${result.taskId} ${result.subject}: ${result.resultSummary || '(see output reference)'}`);
      if (result.outputRef) lines.push(`  Output: ${result.outputRef}`);
    }
  }
  if (packet.teamRoster.length > 0) lines.push(`Team roster: ${packet.teamRoster.join(', ')}`);
  lines.push(
    'Complete the assignment, verify it, and return a concise result with evidence.',
    '</coordination-task>',
  );
  return lines.join('\n');
}

function summarizeHistory(history: Message[]): string[] {
  const recent = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-MAX_CONTEXT_MESSAGES);
  let remaining = MAX_CONTEXT_CHARS;
  const summaries: string[] = [];
  for (const message of recent) {
    if (remaining <= 0) break;
    const normalized = String(message.content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const excerpt = normalized.slice(0, Math.min(remaining, 700));
    summaries.push(`[${message.role}] ${excerpt}`);
    remaining -= excerpt.length;
  }
  return summaries;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
