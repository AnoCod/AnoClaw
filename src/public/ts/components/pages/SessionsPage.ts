// AnoClaw Cinema — SessionsPage: full-bleed conversation with edge bars
// Assembles SessionEdgeBar + ConversationFlow + RightEdgeBar + InputPanel.
// Each session has its own independent SessionAgent with its own emitter.
// Switching sessions = unsubscribing from old agent's emitter and subscribing to new one.

import { App } from '../../app.js';
import { slotRegistry } from '../../SlotRegistry.js';
import type { Page, TokenBreakdown } from '../../types.js';
import type { SessionNode } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { SessionEdgeBar } from './SessionEdgeBar.js';
import { RightEdgeBar } from './RightEdgeBar.js';
import { InputPanel } from '../conversation/InputPanel.js';
import type { Attachment } from '../conversation/types.js';
import { AgentMessageDelegate } from '../conversation/delegates/AgentMessageDelegate.js';
import { UserMessageDelegate } from '../conversation/delegates/UserMessageDelegate.js';
import { ThinkDelegate } from '../conversation/delegates/ThinkDelegate.js';
import { StreamingMessageDelegate } from '../conversation/delegates/StreamingMessageDelegate.js';
import { SubSessionCardDelegate } from '../conversation/delegates/SubSessionCardDelegate.js';
import { DelegationActivityDelegate } from '../conversation/delegates/DelegationActivityDelegate.js';
import { TaskNotificationDelegate } from '../conversation/delegates/TaskNotificationDelegate.js';
import { TaskResolutionDelegate } from '../conversation/delegates/TaskResolutionDelegate.js';
import { TodoWriteDelegate } from '../conversation/delegates/TodoWriteDelegate.js';
import { PlanIndicator } from '../conversation/delegates/PlanIndicator.js';
import { SystemMessageDelegate } from '../conversation/delegates/SystemMessageDelegate.js';
import { StatusDelegate } from '../conversation/delegates/StatusDelegate.js';
import { AskUserQuestionCard } from './SessionsPageAskUser.js';
import { EditResultDelegate } from '../conversation/delegates/EditResultDelegate.js';
import { ToolActivityDelegate } from '../conversation/delegates/ToolActivityDelegate.js';
import type { ToolActivityState } from '../conversation/delegates/ToolActivityDelegate.js';
import { ToolResultDelegate } from '../conversation/delegates/ToolResultDelegate.js';
import { toolCardRegistry } from '../../ToolCardRegistry.js';
import { SessionsPageOverfly } from './SessionsPageOverfly.js';
import { isNearConversationBottom } from './SessionsPageUtils.js';
import type { SessionAgent } from '../../viewmodel/SessionAgent.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';
import { ToastManager } from '../../ToastManager.js';
import { onLocaleChange, refreshLocalizedElements, t } from '../../i18n/index.js';

type ComposerAttachment = Attachment & { content?: string };

export class SessionsPage implements Page {
  name = 'sessions';
  container: HTMLElement;

  private _leftBar: SessionEdgeBar;
  private _rightBar: RightEdgeBar;
  private _centerEl: HTMLElement;
  private _flowEl: HTMLElement;
  private _flowInner: HTMLElement;
  private _jumpLatestButton: HTMLButtonElement;
  private _inputPanel: InputPanel;
  private _welcomeEl: HTMLElement;
  private _streamingDelegate: StreamingMessageDelegate | null = null;
  private _streamingEl: HTMLElement | null = null;
  private _activeSessionId: string | null = null;
  private _activeAgent: SessionAgent | null = null;
  /** Track delegate elements by message ID for in-place updates. */
  private _delegateEls = new Map<string, HTMLElement>();
  /** Track live delegates so updates use component behavior instead of fragile DOM poking. */
  private _delegates = new Map<string, { element: HTMLElement; update?: (msg: any) => void; collapse?: () => void; expand?: () => void }>();
  /** Status card element — always kept at the very bottom above input. */
  private _statusEl: HTMLElement | null = null;
  private _streamStatusEl: HTMLElement | null = null;
  private _loadingEl: HTMLElement | null = null;
  /** Sentinel node — all inserts go before this. Always the last child of _flowInner. */
  private _sentinel: HTMLElement;
  /** Track which AskUserQuestion question indices have been answered per message. */
  private _answeredAskIds = new Map<string, Set<number>>();
  private _compactionOverlay: HTMLElement | null = null;
  private _compactionInProgress = false;
  private _compactionSessionId: string | null = null;
  private _compactionSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private _scrollRaf = 0;
  private _timelineRaf = 0;
  private _timelineResizeObs: ResizeObserver | null = null;
  private _overfly: SessionsPageOverfly;
  private _renderingHistory = false;
  private _workspaceChangedHandler: ((data: unknown) => void) | null = null;
  private _workspacePath: string = '';
  private _showThinkCards = App.getInstance().settings.showThinkCards;
  private _showToolCards = App.getInstance().settings.showToolCards;
  // Scroll tracking — prevent auto-scroll from yanking user back to bottom
  // when they've scrolled up to read history during streaming.
  private _autoScroll: boolean = true;
  private _scrollThreshold: number = 50; // px from bottom to consider "at bottom"

  // Bound event handlers for subscribe/unsubscribe to agent emitter
  private _onStreamingStarted = () => { this._hideWelcome(); this._resetAutoScroll(); this._inputPanel.setStreaming(true); this._startStreamingCard(); };
  private _onStreamToken = (token: string) => this._appendToken(token);
  private _onStreamingStopped = () => this._finalizeStreaming();
  private _onAttemptRolledBack = () => {
    const agent = this._activeAgent;
    if (!agent) return;
    this._renderHistory();
    this._inputPanel.setStreaming(agent.state.isStreaming);
    if (!agent.state.isStreaming) return;
    if (agent.state.streamMsgId) this._removeCard(agent.state.streamMsgId);
    this._startStreamingCard();
    if (agent.state.currentStreamMessage) {
      this._streamingDelegate?.setContent(agent.state.currentStreamMessage);
    }
  };
  private _onTextFinalized = (data: any) => { this._appendCard(data); if (this._streamingDelegate && this._streamingEl) this._streamingDelegate.setContent(''); };
  private _onMessageAdded = (data: any) => this._appendCard(data);
  private _onMessageUpdated = (data: any) => this._updateCard(data);
  private _onMessageRemoved = (data: string) => this._removeCard(data);
  private _onHistoryLoaded = (data: any) => { if ((data as { sessionId: string }).sessionId === this._activeSessionId) this._renderHistory(); };
  private _onHistoryLoading = () => this._showHistoryLoading();
  private _onHistoryLoadError = () => {
    if (this._loadingEl) { this._loadingEl.remove(); this._loadingEl = null; }
  };
  private _onHistoryLoadSettled = () => {
    if (this._loadingEl) { this._loadingEl.remove(); this._loadingEl = null; }
  };
  private _onTokensUpdated = (data: unknown) => {
    const bd = data as TokenBreakdown;
    if (bd && bd.contextWindow > 0) {
      const usedPct = Math.min(100, Math.max(0, Math.round((bd.total / bd.contextWindow) * 100)));
      this._rightBar.setContextPct(usedPct);
    } else {
      this._rightBar.setContextPct(null);
    }
  };
  private _onRowsRemoved = (_start: number, _count: number, ids?: string[]) => {
    if (ids) for (const id of ids) this._removeCard(id);
  };

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-page';

    // Persistent session tree — collapsible to a compact root-session rail.
    this._leftBar = new SessionEdgeBar({
      onSelectSession: (id) => this._onSelectSession(id),
      onNewSession: () => this._onNewSession(),
      onDeleteSession: (id) => this._onDeleteSession(id),
    });

    // Right utility bar — lightweight overview, plan, and context controls.
    this._rightBar = new RightEdgeBar({
      onCompactRequest: () => this._onCompactRequest(),
    });
    this._overfly = new SessionsPageOverfly(() => {
      this._rightBar.setActivePanel(null);
    });

    // Center column = scrollable flow + pinned input
    this._centerEl = document.createElement('div');
    this._centerEl.className = 'cinema-center';

    this._flowEl = document.createElement('div');
    this._flowEl.className = 'cinema-flow';
    this._flowInner = document.createElement('div');
    this._flowInner.className = 'cinema-flow-inner';
    this._flowEl.appendChild(this._flowInner);
    if (typeof ResizeObserver !== 'undefined') {
      this._timelineResizeObs = new ResizeObserver(() => this._scheduleTimelineSync());
      this._timelineResizeObs.observe(this._flowInner);
    }

    // Welcome screen — shown when no session is selected
    this._welcomeEl = this._buildWelcome();
    this._flowInner.appendChild(this._welcomeEl);

    // Sentinel div sits at the bottom of the flow. All new cards insert BEFORE it.
    this._sentinel = document.createElement('div');
    this._sentinel.className = 'cinema-flow-sentinel';
    this._sentinel.style.cssText = 'height:0;overflow:hidden;';
    this._flowInner.appendChild(this._sentinel);

    // Input panel with send/stop callbacks
    this._inputPanel = new InputPanel();
    this._inputPanel.onSend = (content, _mode, attachments) => {
      void this._handleComposerSend(content, attachments as ComposerAttachment[]);
    };
    this._inputPanel.onStop = () => {
      if (this._activeAgent) this._activeAgent.stopGeneration().catch(() => {});
    };

    this._jumpLatestButton = document.createElement('button');
    this._jumpLatestButton.type = 'button';
    this._jumpLatestButton.className = 'cinema-jump-latest';
    this._jumpLatestButton.textContent = t('session.jumpToLatest');
    this._jumpLatestButton.title = t('session.jumpToLatest');
    this._jumpLatestButton.setAttribute('aria-label', t('session.jumpToLatest'));
    this._jumpLatestButton.hidden = true;
    this._jumpLatestButton.addEventListener('click', () => this._jumpToLatest());

    // Listen for workspace-to-agent bridge events (Monaco right-click, file tree right-click)
    window.addEventListener('ws-ask-agent', ((e: CustomEvent) => {
      this._handleAskAgent(e.detail);
    }) as EventListener);
    window.addEventListener('compaction-completed', ((event: CustomEvent) => {
      const detail = event.detail as { sessionId?: string; success?: boolean } | undefined;
      if (!detail?.sessionId || detail.sessionId !== this._compactionSessionId) return;
      this._hideCompactionOverlay(detail.success === true);
    }) as EventListener);
    window.addEventListener('settings-changed', ((e: CustomEvent) => {
      const detail = e.detail || {};
      const nextThink = detail.showThinkCards !== undefined ? Boolean(detail.showThinkCards) : this._showThinkCards;
      const nextTools = detail.showToolCards !== undefined ? Boolean(detail.showToolCards) : this._showToolCards;
      if (nextThink === this._showThinkCards && nextTools === this._showToolCards) return;
      this._showThinkCards = nextThink;
      this._showToolCards = nextTools;
      if (this._activeAgent) this._renderHistory();
    }) as EventListener);

    this._centerEl.appendChild(this._flowEl);
    this._centerEl.appendChild(this._jumpLatestButton);
    this._centerEl.appendChild(this._inputPanel.element);

    // Track user scroll to disable auto-scroll when reading history
    this._flowEl.addEventListener('scroll', () => {
      const el = this._flowEl;
      this._autoScroll = isNearConversationBottom(
        el.scrollHeight,
        el.scrollTop,
        el.clientHeight,
        this._scrollThreshold,
      );
      this._updateJumpLatestVisibility();
    });

    this.container.appendChild(this._leftBar.element);
    this.container.appendChild(this._centerEl);
    this.container.appendChild(this._rightBar.element);

    this._bindEvents();

    // Slots for plugin injection
    if (this._leftBar?.element) {
      const topSlot = document.createElement('div');
      topSlot.setAttribute('data-slot', 'sessions-sidebar-top');
      this._leftBar.element.insertBefore(topSlot, this._leftBar.element.firstChild);
      slotRegistry._onSlotReady('sessions-sidebar-top');
      const bottomSlot = document.createElement('div');
      bottomSlot.setAttribute('data-slot', 'sessions-sidebar-bottom');
      bottomSlot.style.marginTop = 'auto';
      this._leftBar.element.appendChild(bottomSlot);
      slotRegistry._onSlotReady('sessions-sidebar-bottom');
    }
    onLocaleChange(() => this._refreshLocale());
  }

  // Welcome

  private async _handleComposerSend(content: string, attachments: ComposerAttachment[]): Promise<void> {
    const readiness = await this._conversationReadiness();
    if (!readiness.ready) {
      this._inputPanel.restoreDraft(content, attachments);
      this._inputPanel.setStreaming(false);
      this._showWelcome();
      this._updateWelcome();
      this._inputPanel.focus();
      return;
    }

    const app = App.getInstance();
    const convVM = app.conversationVM;
    convVM.inputValue = content;
    convVM.attachments = [...attachments];

    try {
      if (!this._activeAgent) {
        const session = await app.sessionVM.createSession(undefined, undefined);
        if (!session) {
          this._restoreComposerAfterSendFailure(content, attachments);
          return;
        }
      }

      const agent = this._activeAgent;
      if (!agent) {
        this._restoreComposerAfterSendFailure(content, attachments);
        return;
      }

      const sent = await agent.sendMessage(content, convVM.permissionMode, convVM.effortMode, attachments);
      if (!sent) {
        this._restoreComposerAfterSendFailure(content, attachments);
        return;
      }
      convVM.inputValue = '';
      convVM.clearAttachments();
      this._hideWelcome();
      this._resetAutoScroll();
    } catch (e) {
      ClientLogger.ui.error('Failed to send composer message', { error: (e as Error).message });
      this._restoreComposerAfterSendFailure(content, attachments);
    }
  }

  private _restoreComposerAfterSendFailure(content: string, attachments: ComposerAttachment[]): void {
    this._inputPanel.restoreDraft(content, attachments);
    this._inputPanel.setStreaming(false);
    if (!this._activeSessionId) {
      this._showWelcome();
      this._updateWelcome();
    }
    this._inputPanel.focus();
  }

  private async _conversationReadiness(): Promise<{ ready: boolean; message?: string }> {
    const app = App.getInstance();
    try {
      await app.agentVM.ensureLoaded();
    } catch (err) {
      return { ready: false, message: (err as Error).message || t('session.readinessLoadFailed') };
    }
    const result = app.agentVM.selectRunnableAgent(app.sessionVM.activeSession?.agentId);
    return result.ok ? { ready: true } : { ready: false, message: result.message };
  }

  private _buildWelcome(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cinema-welcome';
    el.innerHTML = `
      <div class="cinema-welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.5">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
      </div>
      <div class="cinema-welcome-title" data-welcome-title>${t('session.welcome.defaultTitle')}</div>
      <div class="cinema-welcome-desc" data-welcome-desc>${t('session.welcome.defaultDescription')}</div>
      <div class="cinema-welcome-actions">
        <button type="button" class="cinema-welcome-primary" data-welcome-primary>${t('session.welcome.newSession')}</button>
        <button type="button" class="cinema-welcome-secondary" data-welcome-secondary>${t('session.welcome.agents')}</button>
      </div>
    `;
    el.querySelector<HTMLButtonElement>('[data-welcome-primary]')?.addEventListener('click', () => {
      void this._runWelcomePrimaryAction();
    });
    el.querySelector<HTMLButtonElement>('[data-welcome-secondary]')?.addEventListener('click', () => {
      App.getInstance().navigateTo('agents');
    });
    this._updateWelcome(el);
    return el;
  }

  private _hideWelcome(): void { this._welcomeEl.style.display = 'none'; }
  private _showWelcome(): void { this._updateWelcome(); this._welcomeEl.style.display = ''; }

  private _updateWelcome(target = this._welcomeEl): void {
    if (!target) return;
    const app = App.getInstance();
    const title = target.querySelector<HTMLElement>('[data-welcome-title]');
    const desc = target.querySelector<HTMLElement>('[data-welcome-desc]');
    const primary = target.querySelector<HTMLButtonElement>('[data-welcome-primary]');
    const secondary = target.querySelector<HTMLButtonElement>('[data-welcome-secondary]');
    if (!title || !desc || !primary || !secondary) return;

    const agents = app.agentVM.agents;
    if (agents.length === 0) {
      title.textContent = t('session.welcome.noCeoTitle');
      desc.textContent = t('session.welcome.noCeoDescription');
      primary.textContent = t('session.welcome.openAgents');
      primary.dataset.action = 'agents';
      secondary.hidden = true;
      return;
    }

    const result = app.agentVM.selectRunnableAgent(app.sessionVM.activeSession?.agentId);
    if (!result.ok) {
      title.textContent = t('session.welcome.agentConfigTitle');
      desc.textContent = result.message || t('session.welcome.agentConfigDescription');
      primary.textContent = t('session.welcome.openAgents');
      primary.dataset.action = 'agents';
      secondary.hidden = true;
      return;
    }

    title.textContent = t('session.welcome.defaultTitle');
    desc.textContent = t('session.welcome.defaultDescription');
    primary.textContent = t('session.welcome.newSession');
    primary.dataset.action = 'session';
    secondary.hidden = false;
  }

  private _refreshLocale(): void {
    this._updateWelcome();
    this._jumpLatestButton.textContent = t('session.jumpToLatest');
    this._jumpLatestButton.title = t('session.jumpToLatest');
    this._jumpLatestButton.setAttribute('aria-label', t('session.jumpToLatest'));
    refreshLocalizedElements(this._flowInner);
    AskUserQuestionCard.refreshLocale(this._flowInner);
    if (this._compactionOverlay) {
      const title = this._compactionOverlay.querySelector<HTMLElement>('.compaction-text');
      const description = this._compactionOverlay.querySelector<HTMLElement>('.compaction-sub');
      if (title) title.textContent = t('session.compact.title');
      if (description) description.textContent = t('session.compact.description');
    }
    for (const expand of this._flowInner.querySelectorAll<HTMLButtonElement>('.tool-result-expand')) {
      if (expand.textContent?.includes('+')) expand.textContent = t('session.showDetails');
    }
  }

  private async _runWelcomePrimaryAction(): Promise<void> {
    const action = this._welcomeEl.querySelector<HTMLButtonElement>('[data-welcome-primary]')?.dataset.action;
    if (action === 'agents') {
      App.getInstance().navigateTo('agents');
      return;
    }
    await App.getInstance().sessionVM.createSession(undefined, undefined);
  }

  private _showHistoryLoading(): void {
    this._hideWelcome();
    if (this._loadingEl && this._loadingEl.parentElement) return; // already showing
    this._loadingEl = document.createElement('div');
    this._loadingEl.style.cssText = 'display:flex;flex-direction:column;gap:16px;padding:32px 0;width:100%;';
    for (let i = 0; i < 3; i++) {
      const bar = document.createElement('div');
      bar.className = 'skeleton';
      bar.style.cssText = `width:${[75, 60, 90][i]}%;height:14px;border-radius:4px;`;
      this._loadingEl.appendChild(bar);
    }
    this._flowInner.insertBefore(this._loadingEl, this._sentinel);
  }

  // Agent emitter subscribe / unsubscribe
  // Each session gets its own SessionAgent with its own EventEmitter.
  // When switching sessions, we unbind from the old agent and bind to the new one.
  // This avoids stale references and double-firing handlers.

  private _bindToAgent(agent: SessionAgent): void {
    this._unbindFromAgent();
    this._activeAgent = agent;
    agent.on('streamingStarted', this._onStreamingStarted);
    agent.on('streamToken', this._onStreamToken);
    agent.on('streamingStopped', this._onStreamingStopped);
    agent.on('attemptRolledBack', this._onAttemptRolledBack);
    agent.on('textSegmentFinalized', this._onTextFinalized);
    agent.on('messageAdded', this._onMessageAdded);
    agent.on('messageUpdated', this._onMessageUpdated);
    agent.on('messageRemoved', this._onMessageRemoved);
    agent.on('historyLoaded', this._onHistoryLoaded);
    agent.on('historyLoading', this._onHistoryLoading);
    agent.on('historyLoadError', this._onHistoryLoadError);
    agent.on('historyLoadSettled', this._onHistoryLoadSettled);
    agent.on('tokensUpdated', this._onTokensUpdated);
    agent.on('rowsRemoved', this._onRowsRemoved);
  }

  private _unbindFromAgent(): void {
    if (!this._activeAgent) return;
    this._activeAgent.off('streamingStarted', this._onStreamingStarted);
    this._activeAgent.off('streamToken', this._onStreamToken);
    this._activeAgent.off('streamingStopped', this._onStreamingStopped);
    this._activeAgent.off('attemptRolledBack', this._onAttemptRolledBack);
    this._activeAgent.off('textSegmentFinalized', this._onTextFinalized);
    this._activeAgent.off('messageAdded', this._onMessageAdded);
    this._activeAgent.off('messageUpdated', this._onMessageUpdated);
    this._activeAgent.off('messageRemoved', this._onMessageRemoved);
    this._activeAgent.off('historyLoaded', this._onHistoryLoaded);
    this._activeAgent.off('historyLoading', this._onHistoryLoading);
    this._activeAgent.off('historyLoadError', this._onHistoryLoadError);
    this._activeAgent.off('historyLoadSettled', this._onHistoryLoadSettled);
    this._activeAgent.off('tokensUpdated', this._onTokensUpdated);
    this._activeAgent.off('rowsRemoved', this._onRowsRemoved);
    this._activeAgent = null;
  }

  private _syncContextFromAgent(agent: SessionAgent | null): void {
    const breakdown = agent?.state.tokenBreakdown;
    if (!breakdown || breakdown.contextWindow <= 0) {
      this._rightBar.setContextPct(null);
      return;
    }
    const usedPct = Math.min(100, Math.max(0, Math.round((breakdown.total / breakdown.contextWindow) * 100)));
    this._rightBar.setContextPct(usedPct);
  }

  // Global event bindings
  // activeSessionChanged is the CENTRAL switch — it fires whenever the
  // user picks a different session. All session-switch logic lives here:
  // clear old cards — fetch workspace — bind new agent — load history.

  private _bindEvents(): void {
    const app = App.getInstance();
    const convVM = app.conversationVM;
    const sessionVM = app.sessionVM;
    const agentVM = app.agentVM;

    agentVM.on('agentsLoaded', () => this._updateWelcome());
    agentVM.on('agentsChanged', () => this._updateWelcome());
    agentVM.on('agentUpdated', () => this._updateWelcome());
    agentVM.on('agentCreated', () => this._updateWelcome());
    agentVM.on('agentDeleted', () => this._updateWelcome());
    agentVM.on('agentStatusChanged', () => this._updateWelcome());

    // Session tree mutations — refresh the persistent navigation tree.
    sessionVM.on('sessionAdded', () => {
      this._activeSessionId = sessionVM.activeSessionId;
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
    });
    sessionVM.on('sessionUpdated', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
    });
    sessionVM.on('sessionRemoved', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
    });
    sessionVM.on('sessionsCleared', () => {
      this._leftBar.renderTree([], null);
    });

    sessionVM.on('sessionDeselected', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, null);
    });

    sessionVM.on('sessionSelected', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, sessionVM.activeSessionId);
    });

    // activeSessionChanged: the SINGLE handler for all session switches.
    // Switches agent emitter binding — unsub from old, sub to new.
    convVM.on('activeSessionChanged', (data: unknown) => {
      const newId = data as string | null;
      if (this._activeSessionId === newId && (newId !== null || !this._activeAgent)) return;

      this._streamingDelegate = null;
      this._streamingEl = null;
      if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
      if (this._streamStatusEl) { this._streamStatusEl.remove(); this._streamStatusEl = null; }

      this._answeredAskIds.clear();
      this._resetAutoScroll();
      this._clearFlow();
      this._inputPanel.clear();
      this._inputPanel.clearAttachments?.();
      this._closeOverfly();
      this._activeSessionId = newId;

      if (!newId) {
        this._unbindFromAgent();
        this._workspacePath = '';
        this._leftBar.renderTree(sessionVM.sessions.tree, null);
        this._inputPanel.setStreaming(false);
        this._syncContextFromAgent(null);
        this._showWelcome();
        this._updateWelcome();
        return;
      }

      this._leftBar.setActive(newId);
      this._hideWelcome();

      // Fetch workspace path for relative file path resolution
      this._workspacePath = '';
      fetch(`/api/v1/sessions/${encodeURIComponent(newId)}/workspace`)
        .then(r => r.json()).then(d => { this._workspacePath = d.workspace || ''; }).catch(() => {});

      const agent = convVM.getAgent(newId);
      this._bindToAgent(agent);
      this._inputPanel.setStreaming(agent.state.isStreaming);
      this._syncContextFromAgent(agent);

      if (agent.state.messages.length > 0) {
        this._renderHistory();
      } else {
        agent.loadHistory().catch(() => {});
      }
    });

    // Right bar panel clicks
    window.addEventListener('right-bar-click', ((e: CustomEvent) => {
      const panel = e.detail?.panel;
      this._showInlineCard(panel);
    }) as EventListener);

    // Sub-session selection from delegate
    window.addEventListener('select-session', ((e: CustomEvent) => {
      const id = e.detail?.id;
      if (id) this._onSelectSession(id);
    }) as EventListener);

    // Click delegation for file paths and external URLs
    this._flowEl.addEventListener('click', (e: MouseEvent) => {
      handlePathClick(e, this._workspacePath, this._activeSessionId);
    });
  }

  /** Inject text into the composer input (workspace-to-agent bridge). */
  injectInput(text: string): void {
    if (this._inputPanel) {
      this._inputPanel.setValue(text);
      this._inputPanel.focus();
    }
  }

  private _handleAskAgent(detail: { action: string; activeFile?: string; fileName?: string; language?: string; selectedText?: string }): void {
    const app = App.getInstance();
    // Ensure an active session exists
    const existingId = app.sessionVM?.activeSessionId;
    if (!existingId) {
      app.sessionVM.createSession(undefined, undefined).then(s => {
        if (s) { app.conversationVM.setActiveSession(s.id); this._buildAskMessage(detail); }
      }).catch(() => {});
    } else {
      this._buildAskMessage(detail);
    }
  }

  private _buildAskMessage(detail: { action: string; activeFile?: string; fileName?: string; language?: string; selectedText?: string }): void {
    const { action, fileName, language, selectedText } = detail;
    let msg = '';
    const label = action === 'Review' ? 'Review this file for bugs, style issues, and improvements'
      : action === 'FindBugs' ? 'Find bugs and security issues in this code'
      : action === 'Explain' ? 'Explain what this code does'
      : '';

    msg += label + '\n\n';
    if (fileName) msg += `**File:** ${fileName}\n`;
    if (language) msg += `**Language:** ${language}\n`;
    if (selectedText) {
      msg += '\n```' + (language || '') + '\n' + selectedText + '\n```\n';
    }
    this._inputPanel?.setValue(msg);
    this._inputPanel?.focus();
  }

  // Lifecycle

  onEnter(): void {
    const panel = document.getElementById('sessions-panel');
    if (panel) panel.classList.add('cinema-active');

    const vm = App.getInstance().sessionVM;
    const convVM = App.getInstance().conversationVM;
    const tree = vm.sessions.tree;
    const active = vm.activeSession;
    const activeId = active ? active.id : null;
    this._leftBar.renderTree(tree, activeId);
    this._inputPanel.focus();

    if (activeId && this._activeSessionId !== activeId) {
      this._resetAutoScroll();
      this._streamingDelegate = null;
      this._streamingEl = null;
      if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
      if (this._streamStatusEl) { this._streamStatusEl.remove(); this._streamStatusEl = null; }
      this._activeSessionId = activeId;
      this._leftBar.setActive(activeId);
      this._clearFlow();
      this._inputPanel.clear();
      this._inputPanel.clearAttachments?.();

      this._workspacePath = '';
      fetch(`/api/v1/sessions/${encodeURIComponent(activeId)}/workspace`)
        .then(r => r.json()).then(d => { this._workspacePath = d.workspace || ''; }).catch(() => {});

      const agent = convVM.getAgent(activeId);
      this._bindToAgent(agent);
      this._inputPanel.setStreaming(agent.state.isStreaming);
      this._syncContextFromAgent(agent);

      if (agent.state.messages.length > 0) {
        this._renderHistory();
      } else {
        agent.loadHistory().catch(() => {});
      }
    } else if (activeId) {
      this._hideWelcome();
      this._syncContextFromAgent(this._activeAgent);
    } else {
      this._syncContextFromAgent(null);
      this._showWelcome();
      this._updateWelcome();
    }

    const sseClient = App.getInstance().sseClient;
    this._workspaceChangedHandler = (data: unknown) => {
      const d = data as { sessionId: string; workspace: string };
      if (d.sessionId === this._activeSessionId) {
        this._workspacePath = d.workspace || '';
      }
    };
    sseClient.on('workspace_changed', this._workspaceChangedHandler);
  }

  onExit(): void {
    this._closeOverfly();
    this._rightBar.hideTooltip();

    if (this._workspaceChangedHandler) {
      App.getInstance().sseClient.off('workspace_changed', this._workspaceChangedHandler);
      this._workspaceChangedHandler = null;
    }
    const panel = document.getElementById('sessions-panel');
    if (panel) panel.classList.remove('cinema-active');
  }

  // Session management

  private _onSelectSession(id: string): void {
    console.log('[Sessions] selectSession id:', id);
    if (this._activeSessionId === id) return;
    const sessionVM = App.getInstance().sessionVM;

    sessionVM.selectSession(id);
  }

  private _onNewSession(): void {
    App.getInstance().sessionVM.createSession(undefined, undefined).catch((e) => {
      ClientLogger.ui.error('Failed to create session', { error: (e as Error).message });
    });
  }

  private _onDeleteSession(id: string): void {
    App.getInstance().sessionVM.archiveSession(id).catch((e) => {
      ClientLogger.ui.error('Failed to archive session', { sid: id, error: (e as Error).message });
    });
  }

  private _onCompactRequest(): void {
    if (this._compactionInProgress) return;
    const app = App.getInstance();
    const sessionId = app.sessionVM.activeSessionId;
    if (!sessionId) {
      ToastManager.getInstance().error(t('session.compact.selectFirst'));
      return;
    }
    if (!app.sseClient.connected) {
      ToastManager.getInstance().error(t('session.compact.disconnected'));
      return;
    }
    if (!app.conversationVM.runCommand('compact')) {
      ToastManager.getInstance().error(t('session.compact.sendFailed'));
      return;
    }
    this._compactionSessionId = sessionId;
    this._showCompactionOverlay();
  }

  private _showCompactionOverlay(): void {
    if (this._compactionOverlay) return;
    this._compactionInProgress = true;

    const overlay = document.createElement('div');
    overlay.className = 'compaction-overlay';
    overlay.innerHTML = `
      <div class="compaction-spinner"></div>
      <div class="compaction-text">${t('session.compact.title')}</div>
      <div class="compaction-sub">${t('session.compact.description')}</div>
    `;
    document.body.appendChild(overlay);
    this._compactionOverlay = overlay;
    this._compactionSafetyTimer = setTimeout(() => {
      if (!this._compactionInProgress) return;
      this._compactionSafetyTimer = null;
      ToastManager.getInstance().info(t('session.compact.stillRunning'), 7000);
      this._removeCompactionOverlay(false);
    }, 45_000);
  }

  private _hideCompactionOverlay(confirmed: boolean): void {
    if (this._compactionSafetyTimer) {
      clearTimeout(this._compactionSafetyTimer);
      this._compactionSafetyTimer = null;
    }
    this._compactionInProgress = false;
    this._compactionSessionId = null;
    this._removeCompactionOverlay(confirmed);
  }

  private _removeCompactionOverlay(confirmed: boolean): void {
    const overlay = this._compactionOverlay;
    if (!overlay) return;
    this._compactionOverlay = null;
    if (confirmed) overlay.classList.add('compaction-overlay--done');
    setTimeout(() => overlay.remove(), confirmed ? 400 : 0);
  }

  // Streaming
  // Token-by-token rendering flow:
  //   1. _startStreamingCard() — create a StreamingMessageDelegate and a "Thinking..." status
  //   2. _appendToken() — append each token to the streaming delegate, scroll to bottom
  //   3. _finalizeStreaming() — force final markdown render, remove streaming elements,
  //      then rebuild the ENTIRE message list from agent.state.messages.
  // We rebuild on finalize because the agent may have interleaved think/tool cards
  // during streaming that need to appear in correct chronological order.

  private _startStreamingCard(): void {
    // Always create a fresh streaming delegate — never reuse from a prior turn
    if (this._streamingEl) { this._streamingEl.remove(); this._streamingEl = null; }
    this._streamingDelegate = null;
    const sd = new StreamingMessageDelegate({
      id: 'streaming',
      type: 'assistant',
      content: '',
      timestamp: Date.now(),
      sessionId: this._activeSessionId || '',
      role: 'assistant',
    } as any, {
      onRender: () => {
        this._scheduleTimelineSync();
        this._scrollToBottom();
      },
    });
    this._streamingDelegate = sd;
    this._streamingEl = sd.element;
    this._decorateTimelineStep(this._streamingEl, { type: 'message', role: 'assistant', status: 'pending' });
    this._appendToFlow(this._streamingEl);
    if (this._streamStatusEl) this._streamStatusEl.remove();
    const status = new StatusDelegate('Thinking...');
    this._streamStatusEl = status.element;
    this._appendToFlow(status.element);
  }

  private _appendToken(token: string): void {
    if (this._streamingDelegate && this._streamingEl) {
      this._streamingDelegate.appendToken(token);
      this._scheduleTimelineSync();
    }
  }

  private _finalizeStreaming(): void {
    // textSegmentFinalized already rendered the last text segment as an
    // AgentMessageDelegate before we got here. think/tool cards were inserted
    // before the streaming delegate during streaming. Just tear down the
    // streaming/status elements — no full rebuild needed.
    if (this._streamingDelegate) this._streamingDelegate.complete();
    if (this._streamingEl) { this._streamingEl.remove(); }
    this._streamingDelegate = null;
    this._streamingEl = null;
    if (this._streamStatusEl) { this._streamStatusEl.remove(); this._streamStatusEl = null; }
    if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
    this._inputPanel.setStreaming(false);
    this._collapseCompletedActivityCards();
    this._scheduleTimelineSync();
    this._scrollToBottom();
  }

  // Message rendering
  //
  // _appendCard is the main rendering entry point. It dispatches by msg.type
  // to the correct Delegate class. Each delegate wraps a DOM element.
  //
  // _updateCard handles in-place updates for live cards:
  //   - tool_call: toggle running — done animation, append duration, show output
  //   - think: append text body, update elapsed time
  //   - delegation_activity / status: replace entire card
  //
  // _delegateEls tracks every card by message.id so we can find and update.

  /** Dispatch msg.type to the correct delegate, insert into flow, track by id. */
  private _appendCard(msg: any): void {
    console.log('[Sessions] appendCard type:', msg.type || msg.role, 'id:', msg.id);
    if (!this._shouldRenderMessage(msg)) return;
    this._hideWelcome();
    let delegate: { element: HTMLElement } | null = null;

    const msgType: string = msg.type || '';
    switch (msgType) {
      case 'user':
        delegate = new UserMessageDelegate(msg);
        break;
      case 'assistant':
      case 'agent':
        delegate = new AgentMessageDelegate(msg);
        break;
      case 'tool_call':
        delegate = this._renderToolCallCard(msg);
        break;
      case 'think':
        delegate = new ThinkDelegate(msg);
        break;
      case 'sub_session':
        delegate = new SubSessionCardDelegate(msg);
        break;
      case 'delegation_activity':
        delegate = new DelegationActivityDelegate({
          id: msg.id,
          type: 'delegation_activity',
          content: msg.content,
          subSessionId: msg.subSessionId,
          subAgentId: msg.subAgentId,
          timestamp: msg.timestamp || Date.now(),
        });
        break;
      case 'task_notification': {
        let data: { subSessionId?: string; subAgentId?: string; status?: string; summary?: string; result?: string } = {};
        try { data = JSON.parse(msg.content || '{}'); } catch {}
        const status = msg.taskStatus || data.status || 'completed';
        delegate = new TaskNotificationDelegate({
          subSessionId: data.subSessionId || msg.taskId || '',
          subAgentId: data.subAgentId || msg.parentAgentId || '',
          status: (status === 'failed' ? 'failed' : 'completed') as 'completed' | 'failed',
          summary: msg.taskSummary || data.summary || '',
          result: msg.taskResult || data.result || '',
        }, { notify: !this._renderingHistory });
        break;
      }
      case 'task_resolution': {
        const taskResolution = msg.taskResolution || safeParseJson(msg.content);
        delegate = new TaskResolutionDelegate({ taskResolution });
        break;
      }
      case 'todo_write':
        delegate = new TodoWriteDelegate({ type: 'todo_write', todos: msg.todos || [] });
        break;
      case 'plan_enter':
        delegate = new PlanIndicator({ type: 'plan_enter', title: msg.planTitle, description: msg.content });
        break;
      case 'plan_exit':
        delegate = new PlanIndicator({ type: 'plan_exit' });
        break;
      case 'error':
        delegate = new SystemMessageDelegate({ type: 'system', level: 'error', content: msg.content });
        break;
      case 'status':
        delegate = new StatusDelegate(msg.content);
        break;
      default:
        delegate = this._renderFallbackCard(msg);
        break;
    }

    this._insertCardIntoFlow(delegate, msg);
  }

  /** Build a tool_call card — dispatches to AskUserQuestion, Edit diff, registered, or generic delegates. */
  private _renderToolCallCard(msg: any): { element: HTMLElement } | null {
    // AskUserQuestion gets a special interactive card
    if (msg.toolName === 'AskUserQuestion' && msg.toolInput) {
      const onSendAnswer = async (answer: string): Promise<boolean> => {
        const agent = this._activeAgent;
        if (!agent) return false;
        const convVM = App.getInstance().conversationVM;
        convVM.inputValue = answer;
        const sent = await agent.sendMessage(answer, convVM.permissionMode, convVM.effortMode, []);
        if (sent) convVM.inputValue = '';
        return sent;
      };
      const askCard = AskUserQuestionCard.build(msg, this._answeredAskIds, onSendAnswer);
      return { element: askCard };
    }
    // Edit gets a diff view
    if (msg.toolName === 'Edit' && msg.status === 'success' && msg.toolInput) {
      const filePath = (msg.toolInput as any).file_path || '';
      const oldStr = (msg.toolInput as any).old_string || '';
      const newStr = (msg.toolInput as any).new_string || '';
      return new EditResultDelegate(filePath, oldStr, newStr, true);
    }
    // Try ToolCardRegistry for a custom card
    const CardCtor = toolCardRegistry.get(msg.toolName) as any;
    if (CardCtor) {
      return new CardCtor({
        toolName: msg.toolName || '',
        toolInput: msg.toolInput || {},
        status: (msg.status === 'pending' ? 'running' : msg.status === 'error' ? 'error' : 'success'),
        result: msg.content || undefined,
        durationMs: msg.durationMs,
      });
    }
    // Completed tool call from history — rich ToolResultDelegate
    if (msg.content && msg.status !== 'pending') {
      return new ToolResultDelegate({
        type: 'tool_result',
        toolName: msg.toolName || '',
        content: msg.content || '',
        isError: msg.status === 'error',
        summary: undefined,
        durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : undefined,
        toolInput: msg.toolInput || {},
      });
    }
    // Generic tool activity delegate
    const state: ToolActivityState = {
      toolName: msg.toolName || '',
      toolInput: msg.toolInput || {},
      status: (msg.status === 'pending' ? 'running' : msg.status === 'error' ? 'error' : 'success'),
      result: msg.content || undefined,
      durationMs: msg.durationMs,
    };
    return new ToolActivityDelegate(state);
  }

  /** Fallback card dispatch by role when msg.type is unknown. */
  private _renderFallbackCard(msg: any): { element: HTMLElement } | null {
    if (msg.role === 'user') return new UserMessageDelegate(msg);
    if (msg.role === 'assistant') return new AgentMessageDelegate(msg);
    if (msg.role === 'system') return new UserMessageDelegate(msg);
    return null;
  }

  /** Insert a delegate's element into the flow, tracking by id. Handles status pinning and streaming order. */
  private _insertCardIntoFlow(delegate: { element: HTMLElement } | null, msg: any): void {
    if (!delegate) return;
    const msgId = msg.id as string | undefined;
    if (msgId && this._delegateEls.has(msgId)) {
      this._updateCard(msg);
      return;
    }
    this._decorateTimelineStep(delegate.element, msg);

    // All conversation cards live inside _flowInner. Status cards are pinned
    // to the bottom; normal cards land above streaming/status placeholders.
    const isStatus = msg.type === 'status';
    if (isStatus && this._streamStatusEl) {
      this._streamStatusEl.remove();
      this._streamStatusEl = null;
    }
    const target = isStatus
      ? this._sentinel
      : (this._streamingEl && this._streamingEl.parentElement === this._flowInner)
        ? this._streamingEl
        : (this._streamStatusEl && this._streamStatusEl.parentElement === this._flowInner)
          ? this._streamStatusEl
          : (this._statusEl && this._statusEl.parentElement === this._flowInner)
            ? this._statusEl
            : this._sentinel;

    this._flowInner.insertBefore(delegate.element, target);
    if (msgId) {
      this._delegateEls.set(msgId, delegate.element);
      this._delegates.set(msgId, delegate as any);
    }
    if (isStatus) this._statusEl = delegate.element;
    this._scheduleTimelineSync();
    if (this._autoScroll) this._scrollToBottom();
  }

  /** Update a card in-place without rebuilding the entire flow.
   *  Uses delegate update(msg) methods instead of fragile DOM queries. */
  private _updateCard(msg: any): void {
    const msgId = (msg as any).id as string | undefined;
    if (!msgId) return;
    if (!this._shouldRenderMessage(msg)) {
      this._removeCard(msgId);
      return;
    }
    const oldEl = this._delegateEls.get(msgId);
    if (!oldEl) { this._appendCard(msg); return; }
    const trackedDelegate = this._delegates.get(msgId);
    this._decorateTimelineStep(oldEl, msg);

    let delegate: { element: HTMLElement } | null = null;
    const msgType: string = msg.type || '';
    switch (msgType) {
      case 'tool_call': {
        // Tool cards differ by tool type and by running/completed state.
        // Re-rendering through the dispatcher keeps all variants on the same
        // expand-while-running / collapse-when-complete contract.
        delegate = this._renderToolCallCard(msg);
        break;
      }
      case 'delegation_activity': {
        // Update content span in-place
        const indicator = oldEl.firstElementChild as HTMLElement | null;
        if (indicator && indicator.children.length >= 4) {
          const contentSpan = indicator.children[3] as HTMLElement;
          const newContent = msg.content || '';
          if (contentSpan.textContent !== newContent) {
            contentSpan.textContent = newContent;
          }
        }
        break;
      }
      case 'think': {
        if (trackedDelegate?.update) {
          trackedDelegate.update(msg);
        } else {
          delegate = new ThinkDelegate(msg);
        }
        break;
      }
      case 'task_notification': {
        let tData: { status?: string; summary?: string; result?: string; taskId?: string; parentAgentId?: string } = {};
        try { tData = JSON.parse(msg.content || '{}'); } catch {}
        trackedDelegate?.update?.({
          subSessionId: msg.taskId || tData.taskId || '',
          subAgentId: msg.parentAgentId || tData.parentAgentId || '',
          status: ((msg.taskStatus || tData.status) === 'failed' ? 'failed' : 'completed'),
          summary: msg.taskSummary || tData.summary || '',
          result: msg.taskResult || tData.result || '',
        });
        break;
      }
      case 'status':
        delegate = new StatusDelegate(msg.content);
        break;
      default:
        break;
    }
    if (delegate && delegate.element) {
      this._decorateTimelineStep(delegate.element, msg);
      oldEl.replaceWith(delegate.element);
      this._delegateEls.set(msgId, delegate.element);
      this._delegates.set(msgId, delegate as any);
      if (msgType === 'status') this._statusEl = delegate.element;
    }
    this._scheduleTimelineSync();
    this._scrollToBottom();
  }

  private _collapseCompletedActivityCards(): void {
    for (const delegate of this._delegates.values()) {
      delegate.collapse?.();
    }
    for (const el of Array.from(this._flowInner.querySelectorAll<HTMLElement>('.tool-result-card'))) {
      el.classList.remove('is-expanded');
      el.classList.add('is-collapsed');
      const toggle = el.querySelector<HTMLElement>('.tool-result-toggle');
      if (toggle) toggle.textContent = '+';
      const expand = el.querySelector<HTMLButtonElement>('.tool-result-expand');
      if (expand) expand.textContent = t('session.showDetails');
    }
    for (const body of Array.from(this._flowInner.querySelectorAll<HTMLElement>('.cinema-think-body, .tool-activity-output'))) {
      body.hidden = true;
    }
    for (const btn of Array.from(this._flowInner.querySelectorAll<HTMLElement>('.tool-activity-inline button'))) {
      btn.style.display = 'none';
    }
  }

  private _decorateTimelineStep(el: HTMLElement, msg: any): void {
    const kind = this._timelineKindForMessage(msg);
    el.classList.remove(
      'agent-flow-step',
      'agent-flow-step--think',
      'agent-flow-step--respond',
      'agent-flow-step--tool',
      'agent-flow-step--todo',
      'agent-flow-step--delegate',
      'agent-flow-step--plan',
      'agent-flow-step--error',
      'is-running',
      'is-success',
      'is-error',
      'is-info',
      'has-next-agent-flow-step',
    );
    el.style.removeProperty('--agent-flow-next-distance');
    if (!kind) {
      delete el.dataset.timelineKind;
      delete el.dataset.timelineStatus;
      return;
    }
    const status = this._timelineStatusForMessage(msg);
    el.classList.add('agent-flow-step', `agent-flow-step--${kind}`, `is-${status}`);
    el.dataset.timelineKind = kind;
    el.dataset.timelineStatus = status;
  }

  private _timelineKindForMessage(msg: any): string | null {
    const type = msg.type || '';
    if (type === 'think') return 'think';
    if (type === 'tool_call') return 'tool';
    if (type === 'todo_write') return 'todo';
    if (type === 'task_resolution') return 'delegate';
    if (type === 'delegation_activity' || type === 'task_notification' || type === 'sub_session') return 'delegate';
    if (type === 'plan_enter' || type === 'plan_exit') return 'plan';
    if (type === 'error') return 'error';
    if ((type === 'message' || type === 'assistant' || type === 'agent') && msg.role !== 'user') return 'respond';
    return null;
  }

  private _shouldRenderMessage(msg: any): boolean {
    if (msg?.type === 'think') return this._showThinkCards;
    if (msg?.type === 'tool_call') return this._showToolCards;
    return true;
  }

  private _timelineStatusForMessage(msg: any): string {
    if (msg.type === 'think' && msg.status === 'pending') return 'running';
    if (msg.type === 'tool_call') {
      if (msg.status === 'pending') return 'running';
      if (msg.status === 'error') return 'error';
      return 'success';
    }
    if (msg.type === 'error') return 'error';
    if (msg.status === 'pending') return 'running';
    if (msg.status === 'error') return 'error';
    return 'success';
  }

  private _removeCard(msgId: string): void {
    const el = this._delegateEls.get(msgId);
    if (el) { el.remove(); this._delegateEls.delete(msgId); this._delegates.delete(msgId); }
    if (this._statusEl && msgId === 'status-indicator') {
      this._statusEl.remove();
      this._statusEl = null;
    }
    this._scheduleTimelineSync();
  }

  /** Clear the flow and rebuild all cards from agent.state.messages.
   *  Used on session switch and history load. */
  private _renderHistory(): void {
    this._clearFlow();
    this._hideWelcome();
    // Reset all streaming/bookkeeping state
    this._streamingDelegate = null;
    this._streamingEl = null;
    if (this._streamStatusEl) { this._streamStatusEl.remove(); this._streamStatusEl = null; }
    if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
    const messages = this._activeAgent?.state.messages.messages || [];
    this._renderingHistory = true;
    try {
      for (const msg of messages) this._appendCard(msg);
    } finally {
      this._renderingHistory = false;
    }
    this._scheduleTimelineSync();
  }

  // Overfly panels

  private _showInlineCard(panel: string): void {
    if (!this._activeSessionId) return;
    if (!['overview', 'plan'].includes(panel)) return;
    this._overfly.show(panel, this._activeSessionId, this._workspacePath);
    this._rightBar.setActivePanel(panel);
  }

  private _closeOverfly(): void {
    console.log('[Sessions] overfly close');
    this._overfly.close();
    this._rightBar.setActivePanel(null);
  }

  // Helpers

  private _appendToFlow(el: HTMLElement): void {
    this._flowInner.insertBefore(el, this._sentinel);
    this._scheduleTimelineSync();
  }

  /** Remove all message cards from the flow, keeping welcome + sentinel. */
  private _clearFlow(): void {
    this._delegateEls.clear();
    this._delegates.clear();
    this._statusEl = null;
    this._streamStatusEl = null;
    this._loadingEl = null;
    this._streamingDelegate = null;
    this._streamingEl = null;
    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = 0;
    }
    if (this._timelineRaf) {
      cancelAnimationFrame(this._timelineRaf);
      this._timelineRaf = 0;
    }
    this._jumpLatestButton.hidden = true;
    for (const child of Array.from(this._flowEl.children)) {
      if (child !== this._flowInner) child.remove();
    }
    const children = Array.from(this._flowInner.children);
    for (const child of children) {
      if (child !== this._welcomeEl && child !== this._sentinel) child.remove();
    }
  }

  private _scheduleTimelineSync(): void {
    if (this._timelineRaf) return;
    this._timelineRaf = requestAnimationFrame(() => {
      this._timelineRaf = 0;
      this._syncTimelineSegments();
    });
  }

  private _timelineDotCenterY(el: HTMLElement): number {
    const style = getComputedStyle(el);
    const y = Number.parseFloat(style.getPropertyValue('--agent-flow-dot-y'));
    const size = Number.parseFloat(style.getPropertyValue('--agent-flow-dot-size'));
    const dotY = Number.isFinite(y) ? y : 10;
    const dotSize = Number.isFinite(size) ? size : 7;
    return dotY + dotSize / 2;
  }

  private _syncTimelineSegments(): void {
    const steps = Array.from(this._flowInner.querySelectorAll<HTMLElement>('.agent-flow-step'));
    for (const step of steps) {
      step.classList.remove('has-next-agent-flow-step');
      step.style.removeProperty('--agent-flow-next-distance');
    }

    for (let i = 0; i < steps.length - 1; i++) {
      const current = steps[i];
      const next = steps[i + 1];
      // Connect timeline nodes inside one agent turn. User messages are hard
      // boundaries, so separate prompts do not get one long rail.
      if (this._hasUserMessageBetween(current, next)) continue;

      const currentRect = current.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const distance = Math.round(
        (nextRect.top + this._timelineDotCenterY(next)) -
        (currentRect.top + this._timelineDotCenterY(current)),
      );
      if (distance <= 0) continue;

      current.style.setProperty('--agent-flow-next-distance', distance + 'px');
      current.classList.add('has-next-agent-flow-step');
    }
  }

  private _hasUserMessageBetween(current: HTMLElement, next: HTMLElement): boolean {
    let node = current.nextElementSibling as HTMLElement | null;
    while (node && node !== next) {
      if (node.classList.contains('cinema-user-block')) return true;
      node = node.nextElementSibling as HTMLElement | null;
    }
    return false;
  }
  /** Scroll to the latest message — only if user hasn't scrolled up to read history.
   *  Uses rAF to batch with DOM paint. Re-checks _autoScroll inside rAF
   *  because scroll state may have changed between call and frame. */
  private _scrollToBottom(): void {
    if (!this._autoScroll) return;
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      if (!this._autoScroll) return; // re-check: user may have scrolled up since call
      this._flowEl.scrollTop = this._flowEl.scrollHeight;
      this._updateJumpLatestVisibility();
    });
  }

  /** Force auto-scroll back on — called when user sends a new message. */
  private _resetAutoScroll(): void {
    this._autoScroll = true;
    this._updateJumpLatestVisibility();
  }

  private _jumpToLatest(): void {
    this._autoScroll = true;
    if (this._scrollRaf) {
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = 0;
    }
    this._flowEl.scrollTop = this._flowEl.scrollHeight;
    this._updateJumpLatestVisibility();
  }

  private _updateJumpLatestVisibility(): void {
    this._jumpLatestButton.hidden = this._autoScroll;
  }
}


function safeParseJson(value: unknown): any {
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
