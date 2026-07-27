export type CoordinationEnvelopeType = 'message' | 'event' | 'task';

export type CoordinationDisplayState =
  | 'mailbox_only'
  | 'assigned'
  | 'waiting_workspace'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'delivered'
  | 'info';

export type CoordinationTone = 'info' | 'pending' | 'success' | 'warning' | 'error';

export interface CoordinationPresentation {
  envelopeType: CoordinationEnvelopeType;
  state: CoordinationDisplayState;
  tone: CoordinationTone;
  heading: string;
  statusLabel: string;
  body: string;
  fromAgentId?: string;
  toAgentId?: string;
  taskId?: string;
  kind?: string;
}

export interface InterruptPresentation {
  reason:
    | 'task_self_cancel'
    | 'task_creator_cancel'
    | 'task_coordinator_cancel'
    | 'user_stop'
    | 'parent_stop'
    | 'timeout'
    | 'interrupted'
    | 'halted';
  tone: CoordinationTone;
  heading: string;
  statusLabel: string;
  detail: string;
}

const COORDINATION_OPEN = /^\s*<coordination-(message|event|task)\b([^>]*)>/i;

/**
 * Convert the durable coordination XML envelopes stored in session history
 * into a display model. The storage format remains untouched; only the
 * transcript presentation is normalized.
 */
export function parseCoordinationEnvelope(content: string): CoordinationPresentation | null {
  const source = String(content || '');
  const open = source.match(COORDINATION_OPEN);
  if (!open) return null;

  const envelopeType = open[1].toLowerCase() as CoordinationEnvelopeType;
  const closeTag = `</coordination-${envelopeType}>`;
  const closeAt = source.toLowerCase().lastIndexOf(closeTag);
  if (closeAt < open[0].length) return null;
  if (source.slice(closeAt + closeTag.length).trim()) return null;

  const attributes = parseAttributes(open[2] || '');
  const rawBody = source.slice(open[0].length, closeAt).trim();
  const body = stripCoordinationTags(decodeXmlEntities(rawBody)).trim();
  const lines = body.split(/\r?\n/);
  const summary = lineValue(lines, 'Summary');
  const subject = lineValue(lines, 'Subject');
  const assignment = lineValue(lines, 'Assignment');
  const goal = lineValue(lines, 'Goal');
  const kind = attributes.kind?.toLowerCase();
  const explicitStatus = attributes.status?.toLowerCase();
  const searchable = `${explicitStatus || ''}\n${kind || ''}\n${body}`.toLowerCase();

  const base = {
    envelopeType,
    body: removeHeadingLine(body, summary || subject),
    fromAgentId: attributes['from-agent'],
    toAgentId: attributes['to-agent'],
    taskId: attributes['task-id'],
    kind,
  };

  if (envelopeType === 'message') {
    if (kind === 'note') {
      return {
        ...base,
        state: 'mailbox_only',
        tone: 'info',
        heading: summary || 'Mailbox message',
        statusLabel: 'Delivered · mailbox only',
      };
    }
    if (kind === 'steer') {
      return {
        ...base,
        state: 'delivered',
        tone: 'info',
        heading: summary || 'Live intervention',
        statusLabel: 'Delivered to active session',
      };
    }
    return {
      ...base,
      state: 'delivered',
      tone: 'info',
      heading: summary || coordinationKindHeading(kind, 'Coordination message'),
      statusLabel: 'Delivered',
    };
  }

  if (envelopeType === 'task') {
    return {
      ...base,
      state: 'assigned',
      tone: 'pending',
      heading: assignment || goal || 'Coordination task',
      statusLabel: 'Assigned · waiting to run',
    };
  }

  // A durable mailbox is agent-wide, so a note first delivered to one
  // sub-session may later be injected into another as a coordination-event.
  // Preserve the original mailbox-only semantics in both envelope forms.
  if (kind === 'note') {
    return {
      ...base,
      state: 'mailbox_only',
      tone: 'info',
      heading: summary || 'Mailbox message',
      statusLabel: 'Delivered · mailbox only',
    };
  }
  if (kind === 'steer') {
    return {
      ...base,
      state: 'delivered',
      tone: 'info',
      heading: summary || 'Live intervention',
      statusLabel: 'Delivered to active session',
    };
  }

  const heading = subject || cleanSummaryStatus(summary) || coordinationKindHeading(kind, 'Coordination update');
  if (explicitStatus === 'cancelled' || explicitStatus === 'canceled') {
    return { ...base, state: 'cancelled', tone: 'warning', heading, statusLabel: 'Task cancelled' };
  }
  if (explicitStatus === 'failed') {
    return { ...base, state: 'failed', tone: 'error', heading, statusLabel: 'Task failed' };
  }
  if (explicitStatus === 'completed') {
    return { ...base, state: 'completed', tone: 'success', heading, statusLabel: 'Task completed' };
  }
  if (explicitStatus === 'blocked' && /workspace_conflict|workspace conflict|等待工作区/.test(searchable)) {
    return { ...base, state: 'waiting_workspace', tone: 'pending', heading, statusLabel: 'Waiting for workspace' };
  }
  if (explicitStatus === 'blocked') {
    return { ...base, state: 'blocked', tone: 'warning', heading, statusLabel: 'Task blocked' };
  }
  if (explicitStatus === 'running') {
    return { ...base, state: 'running', tone: 'pending', heading, statusLabel: 'Task running' };
  }

  if (/\b(cancelled|canceled)\b|已取消/.test(searchable)) {
    return { ...base, state: 'cancelled', tone: 'warning', heading, statusLabel: 'Task cancelled' };
  }
  if (/\bfailed\b|失败/.test(searchable)) {
    return { ...base, state: 'failed', tone: 'error', heading, statusLabel: 'Task failed' };
  }
  if (/\bcompleted\b|已完成/.test(searchable)) {
    return { ...base, state: 'completed', tone: 'success', heading, statusLabel: 'Task completed' };
  }
  if (/workspace_conflict|workspace conflict|等待工作区/.test(searchable)) {
    return { ...base, state: 'waiting_workspace', tone: 'pending', heading, statusLabel: 'Waiting for workspace' };
  }
  if (/\bblocked\b|受阻/.test(searchable)) {
    return { ...base, state: 'blocked', tone: 'warning', heading, statusLabel: 'Task blocked' };
  }
  if (/\brunning\b|执行中/.test(searchable)) {
    return { ...base, state: 'running', tone: 'pending', heading, statusLabel: 'Task running' };
  }
  if (kind === 'task_assignment') {
    return { ...base, state: 'assigned', tone: 'pending', heading, statusLabel: 'Assigned · waiting to run' };
  }
  if (kind === 'task_result') {
    return { ...base, state: 'completed', tone: 'success', heading, statusLabel: 'Task result delivered' };
  }
  return { ...base, state: 'info', tone: 'info', heading, statusLabel: 'Coordination update' };
}

/** Map persisted/runtime interruption markers to an explicit UI explanation. */
export function parseInterruptNotice(content: string): InterruptPresentation | null {
  const normalized = String(content || '').trim();
  const exact: Record<string, InterruptPresentation> = {
    '(Agent cancelled its own task)': {
      reason: 'task_self_cancel',
      tone: 'warning',
      heading: 'Task cancelled',
      statusLabel: 'Cancelled by this agent',
      detail: 'The agent executing this task cancelled its own assignment.',
    },
    '(Task cancelled by its creator)': {
      reason: 'task_creator_cancel',
      tone: 'warning',
      heading: 'Task cancelled',
      statusLabel: 'Cancelled by task creator',
      detail: 'The agent that created this task cancelled it.',
    },
    '(Task cancelled by the team coordinator)': {
      reason: 'task_coordinator_cancel',
      tone: 'warning',
      heading: 'Task cancelled',
      statusLabel: 'Cancelled by team coordinator',
      detail: 'The team coordinator cancelled this task.',
    },
    '(User stopped)': {
      reason: 'user_stop',
      tone: 'warning',
      heading: 'Generation stopped',
      statusLabel: 'Stopped by user',
      detail: 'The user stopped this session.',
    },
    '(Parent session stopped)': {
      reason: 'parent_stop',
      tone: 'warning',
      heading: 'Session stopped',
      statusLabel: 'Parent session stopped',
      detail: 'This session stopped because its parent session was stopped.',
    },
    '(Session timed out)': {
      reason: 'timeout',
      tone: 'warning',
      heading: 'Session timed out',
      statusLabel: 'Timeout',
      detail: 'This session exceeded its execution time limit.',
    },
    '(Request interrupted)': {
      reason: 'interrupted',
      tone: 'warning',
      heading: 'Request interrupted',
      statusLabel: 'Interrupted',
      detail: 'This request was interrupted before it completed.',
    },
    'Halted.': {
      reason: 'halted',
      tone: 'warning',
      heading: 'Session halted',
      statusLabel: 'Halted',
      detail: 'This session halted before producing a complete response.',
    },
  };
  if (exact[normalized]) return exact[normalized];

  // Backward compatibility for older persisted variants such as
  // "[Request interrupted: user_stop]".
  const legacy = normalized.match(/^\[Request interrupted(?::\s*([a-z_-]+))?\]$/i);
  if (!legacy) return null;
  const reason = (legacy[1] || '').toLowerCase();
  if (reason === 'user_stop') return exact['(User stopped)'];
  if (reason === 'parent_stop') return exact['(Parent session stopped)'];
  return exact['(Request interrupted)'];
}

function parseAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    result[match[1].toLowerCase()] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return result;
}

function lineValue(lines: string[], label: string): string {
  const prefix = `${label.toLowerCase()}:`;
  const line = lines.find((candidate) => candidate.trim().toLowerCase().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : '';
}

function removeHeadingLine(body: string, heading: string): string {
  if (!heading) return body;
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === `Summary: ${heading}` || trimmed === `Subject: ${heading}`;
  });
  if (index >= 0) lines.splice(index, 1);
  return lines.join('\n').trim();
}

function cleanSummaryStatus(summary: string): string {
  return summary.replace(/\s*:\s*(pending|claimed|running|blocked|completed|failed|cancelled|canceled)\s*$/i, '').trim();
}

function coordinationKindHeading(kind: string | undefined, fallback: string): string {
  if (!kind) return fallback;
  const headings: Record<string, string> = {
    task_assignment: 'Task assignment',
    task_update: 'Task update',
    task_result: 'Task result',
    broadcast: 'Team broadcast',
    organization: 'Organization message',
  };
  return headings[kind] || fallback;
}

function stripCoordinationTags(content: string): string {
  return content
    .replace(/<\/?coordination-(?:message|event|task)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => decodeCodePoint(match, hex, 16))
    .replace(/&#(\d+);/g, (match, decimal: string) => decodeCodePoint(match, decimal, 10))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeCodePoint(fallback: string, value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}
