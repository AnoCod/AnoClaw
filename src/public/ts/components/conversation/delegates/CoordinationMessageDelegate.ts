import { renderMarkdown } from '../../../MarkdownRenderer.js';
import type { ConversationMessage } from '../types.js';
import {
  parseCoordinationEnvelope,
  parseInterruptNotice,
  type CoordinationPresentation,
  type InterruptPresentation,
} from '../CoordinationPresentation.js';
import { getLocale, onLocaleChange, t } from '../../../i18n/index.js';

export class CoordinationMessageDelegate {
  element: HTMLElement;
  private readonly _msg: ConversationMessage;

  constructor(
    msg: ConversationMessage,
    presentation: CoordinationPresentation,
  ) {
    this._msg = msg;
    this.element = document.createElement('div');
    this._render(presentation);
    this._subscribeToLocale(() => {
      const localized = parseCoordinationEnvelope(this._msg.content);
      if (localized) this._render(localized);
    });
  }

  private _render(presentation: CoordinationPresentation): void {
    renderNoticeCard({
      tone: presentation.tone,
      category: categoryLabel(presentation.envelopeType),
      heading: presentation.heading,
      statusLabel: presentation.statusLabel,
      body: presentation.body,
      route: routeLabel(this._msg.agentName || presentation.fromAgentId, presentation.toAgentId),
      footer: presentation.taskId ? t('coordination.footer.task', { taskId: presentation.taskId }) : '',
      timestamp: this._msg.timestamp,
      dataKind: presentation.envelopeType,
      dataState: presentation.state,
      sessionId: this._msg.sessionId,
    }, this.element);
  }

  private _subscribeToLocale(refresh: () => void): void {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = onLocaleChange(() => {
      if ('isConnected' in this.element && !this.element.isConnected) {
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      refresh();
    });
  }
}

export class InterruptNoticeDelegate {
  element: HTMLElement;
  private readonly _msg: ConversationMessage;

  constructor(
    msg: ConversationMessage,
    presentation: InterruptPresentation,
  ) {
    this._msg = msg;
    this.element = document.createElement('div');
    this._render(presentation);
    this._subscribeToLocale(() => {
      const localized = parseInterruptNotice(this._msg.content);
      if (localized) this._render(localized);
    });
  }

  private _render(presentation: InterruptPresentation): void {
    renderNoticeCard({
      tone: presentation.tone,
      category: t('coordination.category.sessionStatus'),
      heading: presentation.heading,
      statusLabel: presentation.statusLabel,
      body: presentation.detail,
      timestamp: this._msg.timestamp,
      dataKind: 'interrupt',
      dataState: presentation.reason,
      sessionId: this._msg.sessionId,
    }, this.element);
  }

  private _subscribeToLocale(refresh: () => void): void {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = onLocaleChange(() => {
      if ('isConnected' in this.element && !this.element.isConnected) {
        unsubscribe?.();
        unsubscribe = null;
        return;
      }
      refresh();
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

function renderNoticeCard(
  options: NoticeCardOptions,
  card: HTMLElement = document.createElement('div'),
): HTMLElement {
  card.replaceChildren();
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
  if (type === 'message') return t('coordination.category.agentMessage');
  if (type === 'task') return t('coordination.category.task');
  return t('coordination.category.coordination');
}

function routeLabel(fromAgentId?: string, toAgentId?: string): string {
  if (fromAgentId && toAgentId) return `${fromAgentId} → ${toAgentId}`;
  if (fromAgentId) return t('coordination.route.from', { agent: fromAgentId });
  if (toAgentId) return t('coordination.route.to', { agent: toAgentId });
  return '';
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime())) return '';
  return time.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}
