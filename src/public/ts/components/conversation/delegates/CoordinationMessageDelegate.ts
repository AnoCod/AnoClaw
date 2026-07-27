import { renderMarkdown } from '../../../MarkdownRenderer.js';
import type { ConversationMessage } from '../types.js';
import type {
  CoordinationPresentation,
  InterruptPresentation,
} from '../CoordinationPresentation.js';

export class CoordinationMessageDelegate {
  element: HTMLElement;

  constructor(
    msg: ConversationMessage,
    presentation: CoordinationPresentation,
  ) {
    this.element = renderNoticeCard({
      tone: presentation.tone,
      category: categoryLabel(presentation.envelopeType),
      heading: presentation.heading,
      statusLabel: presentation.statusLabel,
      body: presentation.body,
      route: routeLabel(msg.agentName || presentation.fromAgentId, presentation.toAgentId),
      footer: presentation.taskId ? `Task ${presentation.taskId}` : '',
      timestamp: msg.timestamp,
      dataKind: presentation.envelopeType,
      dataState: presentation.state,
      sessionId: msg.sessionId,
    });
  }
}

export class InterruptNoticeDelegate {
  element: HTMLElement;

  constructor(
    msg: ConversationMessage,
    presentation: InterruptPresentation,
  ) {
    this.element = renderNoticeCard({
      tone: presentation.tone,
      category: 'Session status',
      heading: presentation.heading,
      statusLabel: presentation.statusLabel,
      body: presentation.detail,
      timestamp: msg.timestamp,
      dataKind: 'interrupt',
      dataState: presentation.reason,
      sessionId: msg.sessionId,
    });
  }
}

interface NoticeCardOptions {
  tone: 'info' | 'pending' | 'success' | 'warning' | 'error';
  category: string;
  heading: string;
  statusLabel: string;
  body: string;
  route?: string;
  footer?: string;
  timestamp?: string;
  dataKind: string;
  dataState: string;
  sessionId?: string;
}

function renderNoticeCard(options: NoticeCardOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = `coordination-transcript-card coordination-transcript-card--${options.tone}`;
  card.dataset.coordinationKind = options.dataKind;
  card.dataset.coordinationState = options.dataState;

  const header = document.createElement('div');
  header.className = 'coordination-transcript-header';

  const headingGroup = document.createElement('div');
  headingGroup.className = 'coordination-transcript-heading';

  const category = document.createElement('span');
  category.className = 'coordination-transcript-category';
  category.textContent = options.category;
  headingGroup.appendChild(category);

  const heading = document.createElement('strong');
  heading.textContent = options.heading;
  headingGroup.appendChild(heading);
  header.appendChild(headingGroup);

  const status = document.createElement('span');
  status.className = 'coordination-transcript-status';
  status.textContent = options.statusLabel;
  header.appendChild(status);
  card.appendChild(header);

  if (options.route) {
    const route = document.createElement('div');
    route.className = 'coordination-transcript-route';
    route.textContent = options.route;
    card.appendChild(route);
  }

  if (options.body) {
    const body = document.createElement('div');
    body.className = 'coordination-transcript-body';
    body.innerHTML = renderMarkdown(options.body, { sessionId: options.sessionId });
    card.appendChild(body);
  }

  const metadata = [options.footer, formatTime(options.timestamp)].filter(Boolean).join(' · ');
  if (metadata) {
    const footer = document.createElement('div');
    footer.className = 'coordination-transcript-footer';
    footer.textContent = metadata;
    card.appendChild(footer);
  }

  return card;
}

function categoryLabel(type: CoordinationPresentation['envelopeType']): string {
  if (type === 'message') return 'Agent message';
  if (type === 'task') return 'Task';
  return 'Coordination';
}

function routeLabel(fromAgentId?: string, toAgentId?: string): string {
  if (fromAgentId && toAgentId) return `${fromAgentId} → ${toAgentId}`;
  if (fromAgentId) return `From ${fromAgentId}`;
  if (toAgentId) return `To ${toAgentId}`;
  return '';
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime())) return '';
  return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
