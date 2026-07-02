// AnoClaw Cinema — SessionsPage: full-bleed conversation with edge bars
// Assembles SessionEdgeBar + ConversationFlow + RightEdgeBar + InputPanel.
// Each session has its own independent SessionAgent with its own emitter.
// Switching sessions = unsubscribing from old agent's emitter and subscribing to new one.

import { App } from '../../app.js';
import { pageRegistry } from '../../PageRegistry.js';
import type { Page, TokenBreakdown } from '../../types.js';
import type { SessionNode } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { SessionEdgeBar } from './SessionEdgeBar.js';
import { RightEdgeBar } from './RightEdgeBar.js';
import { InputPanel } from '../conversation/InputPanel.js';
import { AgentMessageDelegate } from '../conversation/delegates/AgentMessageDelegate.js';
import { UserMessageDelegate } from '../conversation/delegates/UserMessageDelegate.js';
import { ThinkDelegate } from '../conversation/delegates/ThinkDelegate.js';
import { StreamingMessageDelegate } from '../conversation/delegates/StreamingMessageDelegate.js';
import { SubSessionCardDelegate } from '../conversation/delegates/SubSessionCardDelegate.js';
import { DelegationActivityDelegate } from '../conversation/delegates/DelegationActivityDelegate.js';
import { TaskNotificationDelegate } from '../conversation/delegates/TaskNotificationDelegate.js';
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
import type { SessionAgent } from '../../viewmodel/SessionAgent.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';

export class SessionsPage implements Page {
  name = 'sessions';
  container: HTMLElement;

  private _leftBar: SessionEdgeBar;
  private _rightBar: RightEdgeBar;
  private _centerEl: HTMLElement;
  private _flowEl: HTMLElement;
  private _flowInner: HTMLElement;
  private _inputPanel: InputPanel;
  private _welcomeEl: HTMLElement;
  private _streamingDelegate: StreamingMessageDelegate | null = null;
  private _streamingEl: HTMLElement | null = null;
  private _activeSessionId: string | null = null;
  private _activeAgent: SessionAgent | null = null;
  /** Track delegate elements by message ID for in-place updates. */
  private _delegateEls = new Map<string, HTMLElement>();
  /** Status card element — always kept at the very bottom above input. */
  private _statusEl: HTMLElement | null = null;
  private _loadingEl: HTMLElement | null = null;
  /** Sentinel node — all inserts go before this. Always the last child of _flowInner. */
  private _sentinel: HTMLElement;
  /** Track which AskUserQuestion question indices have been answered per message. */
  private _answeredAskIds = new Map<string, Set<number>>();
  private _compactionOverlay: HTMLElement | null = null;
  private _compactionInProgress = false;
  private _compactionSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private _overfly = new SessionsPageOverfly();
  private _workspaceChangedHandler: ((data: unknown) => void) | null = null;
  private _workspacePath: string = '';
  private _filesTab: import('../tabs/FilesTab.js').FilesTab | null = null;
  // Scroll tracking — prevent auto-scroll from yanking user back to bottom
  // when they've scrolled up to read history during streaming.
  private _autoScroll: boolean = true;
  private _scrollThreshold: number = 50; // px from bottom to consider "at bottom"

  // Bound event handlers for subscribe/unsubscribe to agent emitter
  private _onStreamingStarted = () => { this._hideWelcome(); this._resetAutoScroll(); this._startStreamingCard(); };
  private _onStreamToken = (token: string) => this._appendToken(token);
  private _onStreamingStopped = () => this._finalizeStreaming();
  private _onTextFinalized = (data: any) => { this._appendCard(data); if (this._streamingDelegate && this._streamingEl) this._streamingDelegate.setContent(''); };
  private _onMessageAdded = (data: any) => this._appendCard(data);
  private _onMessageUpdated = (data: any) => this._updateCard(data);
  private _onMessageRemoved = (data: string) => this._removeCard(data);
  private _onHistoryLoaded = (data: any) => { if ((data as { sessionId: string }).sessionId === this._activeSessionId) this._renderHistory(); };
  private _onHistoryLoading = () => this._showHistoryLoading();
  private _onHistoryLoadError = () => {
    if (this._loadingEl) { this._loadingEl.remove(); this._loadingEl = null; }
  };
  private _onTokensUpdated = (data: unknown) => { const bd = data as TokenBreakdown; if (bd && bd.contextWindow > 0) { const freePct = Math.max(0, 100 - Math.round((bd.total / bd.contextWindow) * 100)); this._rightBar.setContextPct(freePct); } };
  private _onRowsRemoved = (_start: number, _count: number, ids?: string[]) => {
    if (ids) for (const id of ids) this._removeCard(id);
  };

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-page';

    // Left 48px bar — session dots, new/delete buttons
    this._leftBar = new SessionEdgeBar({
      onSelectSession: (id) => this._onSelectSession(id),
      onNewSession: () => this._onNewSession(),
      onDeleteSession: (id) => this._onDeleteSession(id),
    });

    // Right 48px bar — files, overview, plan, context icons
    this._rightBar = new RightEdgeBar({
      onCompactRequest: () => this._onCompactRequest(),
    });

    this._overfly.onFilesRefreshed = (count: number) => {
      this._rightBar.setFileCount(count);
    };

    // Center column = scrollable flow + pinned input
    this._centerEl = document.createElement('div');
    this._centerEl.className = 'cinema-center';

    this._flowEl = document.createElement('div');
    this._flowEl.className = 'cinema-flow';
    this._flowInner = document.createElement('div');
    this._flowInner.className = 'cinema-flow-inner';
    this._flowEl.appendChild(this._flowInner);

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
      const convVM = App.getInstance().conversationVM;
      convVM.inputValue = content;
      if (attachments && attachments.length > 0) {
        for (const a of attachments) convVM.addAttachment(a as any);
      }

      this._hideWelcome();
      this._resetAutoScroll(); // user sent a message — re-anchor to bottom
      this._inputPanel.setStreaming(true);
      this._inputPanel.clear();

      const send = () => {
        const agent = this._activeAgent;
        if (!agent) return;
        agent.sendMessage(convVM.inputValue, convVM.permissionMode, convVM.effortMode, convVM.attachments).catch(() => {});
        convVM.inputValue = '';
        convVM.clearAttachments();
      };

      // If no active session yet, auto-create one before sending
      if (this._activeAgent) {
        send();
      } else {
        App.getInstance().sessionVM.createSession(undefined, undefined).then((session) => {
          if (session) {
            App.getInstance().conversationVM.setActiveSession(session.id);
            send();
          }
        }).catch((e) => {
          ClientLogger.ui.error('Failed to auto-create session', { error: (e as Error).message });
        });
      }
    };
    this._inputPanel.onStop = () => {
      if (this._activeAgent) this._activeAgent.stopGeneration().catch(() => {});
    };

    // Listen for workspace→agent bridge events (Monaco right-click, file tree right-click)
    window.addEventListener('ws-ask-agent', ((e: CustomEvent) => {
      this._handleAskAgent(e.detail);
    }) as EventListener);

    this._centerEl.appendChild(this._flowEl);
    this._centerEl.appendChild(this._inputPanel.element);

    // Track user scroll to disable auto-scroll when reading history
    this._flowEl.addEventListener('scroll', () => {
      const el = this._flowEl;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this._autoScroll = distFromBottom < this._scrollThreshold;
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
      const bottomSlot = document.createElement('div');
      bottomSlot.setAttribute('data-slot', 'sessions-sidebar-bottom');
      bottomSlot.style.marginTop = 'auto';
      this._leftBar.element.appendChild(bottomSlot);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Welcome
  // ═══════════════════════════════════════════════════════════════════

  private _buildWelcome(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cinema-welcome';
    el.innerHTML = `
      <div class="cinema-welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.5">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
      </div>
      <div class="cinema-welcome-title">Welcome to AnoClaw</div>
      <div class="cinema-welcome-desc">Start a new conversation or select a session from the left bar.</div>
    `;
    return el;
  }

  private _hideWelcome(): void { this._welcomeEl.style.display = 'none'; }
  private _showWelcome(): void { this._welcomeEl.style.display = ''; }

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

  // ═══════════════════════════════════════════════════════════════════
  // Agent emitter subscribe / unsubscribe
  // Each session gets its own SessionAgent with its own EventEmitter.
  // When switching sessions, we unbind from the old agent and bind to the new one.
  // This avoids stale references and double-firing handlers.
  // ═══════════════════════════════════════════════════════════════════

  private _bindToAgent(agent: SessionAgent): void {
    this._unbindFromAgent();
    this._activeAgent = agent;
    agent.on('streamingStarted', this._onStreamingStarted);
    agent.on('streamToken', this._onStreamToken);
    agent.on('streamingStopped', this._onStreamingStopped);
    agent.on('textSegmentFinalized', this._onTextFinalized);
    agent.on('messageAdded', this._onMessageAdded);
    agent.on('messageUpdated', this._onMessageUpdated);
    agent.on('messageRemoved', this._onMessageRemoved);
    agent.on('historyLoaded', this._onHistoryLoaded);
    agent.on('historyLoading', this._onHistoryLoading);
    agent.on('historyLoadError', this._onHistoryLoadError);
    agent.on('tokensUpdated', this._onTokensUpdated);
    agent.on('rowsRemoved', this._onRowsRemoved);
  }

  private _unbindFromAgent(): void {
    if (!this._activeAgent) return;
    this._activeAgent.off('streamingStarted', this._onStreamingStarted);
    this._activeAgent.off('streamToken', this._onStreamToken);
    this._activeAgent.off('streamingStopped', this._onStreamingStopped);
    this._activeAgent.off('textSegmentFinalized', this._onTextFinalized);
    this._activeAgent.off('messageAdded', this._onMessageAdded);
    this._activeAgent.off('messageUpdated', this._onMessageUpdated);
    this._activeAgent.off('messageRemoved', this._onMessageRemoved);
    this._activeAgent.off('historyLoaded', this._onHistoryLoaded);
    this._activeAgent.off('historyLoading', this._onHistoryLoading);
    this._activeAgent.off('historyLoadError', this._onHistoryLoadError);
    this._activeAgent.off('tokensUpdated', this._onTokensUpdated);
    this._activeAgent.off('rowsRemoved', this._onRowsRemoved);
    this._activeAgent = null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Global event bindings
  // activeSessionChanged is the CENTRAL switch — it fires whenever the
  // user picks a different session. All session-switch logic lives here:
  // clear old cards → fetch workspace → bind new agent → load history.
  // ═══════════════════════════════════════════════════════════════════

  private _bindEvents(): void {
    const convVM = App.getInstance().conversationVM;
    const sessionVM = App.getInstance().sessionVM;

    // Session tree mutations — re-render left bar dots
    sessionVM.on('sessionAdded', () => {
      this._activeSessionId = sessionVM.activeSessionId;
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
    });
    sessionVM.on('sessionUpdated', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
    });
    sessionVM.on('sessionRemoved', (removed: unknown) => {
      const r = removed as { id: string };
      const isActiveDeleted = r.id === this._activeSessionId;
      this._activeSessionId = sessionVM.activeSessionId;
      this._leftBar.renderTree(sessionVM.sessions.tree, this._activeSessionId);
      if (isActiveDeleted) {
        this._clearFlow();
        this._showWelcome();
        this._closeOverfly();
      }
    });

    sessionVM.on('sessionDeselected', () => {
      this._activeSessionId = null;
      this._clearFlow();
      this._showWelcome();
      this._closeOverfly();
    });

    sessionVM.on('sessionSelected', () => {
      this._leftBar.renderTree(sessionVM.sessions.tree, sessionVM.activeSessionId);
    });

    // activeSessionChanged: the SINGLE handler for all session switches.
    // Switches agent emitter binding — unsub from old, sub to new.
    convVM.on('activeSessionChanged', (data: unknown) => {
      const newId = data as string;
      if (this._activeSessionId === newId) return;

      this._streamingDelegate = null;
      this._streamingEl = null;
      if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }

      this._activeSessionId = newId;
      this._leftBar.setActive(newId);
      this._answeredAskIds.clear();
      this._clearFlow();
      this._hideWelcome();
      this._inputPanel.clear();
      this._inputPanel.clearAttachments?.();

      // Fetch workspace path for relative file path resolution
      this._workspacePath = '';
      fetch(`/api/v1/sessions/${encodeURIComponent(newId)}/workspace`)
        .then(r => r.json()).then(d => { this._workspacePath = d.workspace || ''; }).catch(() => {});

      const agent = convVM.getAgent(newId);
      this._bindToAgent(agent);
      this._inputPanel.setStreaming(agent.state.isStreaming);

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
      handlePathClick(e, this._workspacePath);
    });
  }

  /** Inject text into the composer input (workspace→agent bridge). */
  injectInput(text: string): void {
    if (this._inputPanel) {
      this._inputPanel.setValue(text);
      this._inputPanel.focus();
    }
  }

  private _handleAskAgent(detail: { action: string; activeFile?: string; fileName?: string; language?: string; selectedText?: string }): void {
    // Navigate to sessions page if needed
    const app = App.getInstance();
    if (pageRegistry.currentPage !== 'sessions') {
      pageRegistry.navigateTo('sessions');
    }
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

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

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
      this._streamingDelegate = null;
      this._streamingEl = null;
      if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
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

      if (agent.state.messages.length > 0) {
        this._renderHistory();
      } else {
        agent.loadHistory().catch(() => {});
      }
    } else if (activeId) {
      this._hideWelcome();
    }

    const sseClient = App.getInstance().sseClient;
    this._workspaceChangedHandler = (data: unknown) => {
      const d = data as { sessionId: string; workspace: string };
      if (d.sessionId === this._activeSessionId) {
        this._workspacePath = d.workspace || '';
        // Also update the FilesTab if open
        const filesTab = this._filesTab;
        if (filesTab) {
          filesTab.updateWorkspaceLabel(d.workspace || '');
          try { filesTab.refreshDirectory('/'); } catch {}
        }
        // Refresh overfly file list
        if (this._overfly) {
          this._overfly.refreshFilesIfOpen(d.sessionId);
        }
      }
      if (d.sessionId) this._overfly.refreshFilesIfOpen(d.sessionId);
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

  // ═══════════════════════════════════════════════════════════════════
  // Session management
  // ═══════════════════════════════════════════════════════════════════

  private _onSelectSession(id: string): void {
    console.log('[Sessions] selectSession id:', id);
    if (this._activeSessionId === id) return;
    const convVM = App.getInstance().conversationVM;
    const sessionVM = App.getInstance().sessionVM;

    convVM.setActiveSession(id);
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
    this._showCompactionOverlay();
    App.getInstance().conversationVM.runCommand('compact');
  }

  private _showCompactionOverlay(): void {
    if (this._compactionOverlay) return;
    this._compactionInProgress = true;

    const overlay = document.createElement('div');
    overlay.className = 'compaction-overlay';
    overlay.innerHTML = `
      <div class="compaction-spinner"></div>
      <div class="compaction-text">Compacting context...</div>
      <div class="compaction-sub">Summarizing conversation history to free up space</div>
    `;
    document.body.appendChild(overlay);
    this._compactionOverlay = overlay;
    this._compactionSafetyTimer = setTimeout(() => {
      if (this._compactionInProgress) this._hideCompactionOverlay();
    }, 10_000);
  }

  private _hideCompactionOverlay(): void {
    if (this._compactionSafetyTimer) {
      clearTimeout(this._compactionSafetyTimer);
      this._compactionSafetyTimer = null;
    }
    this._compactionInProgress = false;
    if (this._compactionOverlay) {
      this._compactionOverlay.classList.add('compaction-overlay--done');
      setTimeout(() => {
        if (this._compactionOverlay) {
          this._compactionOverlay.remove();
          this._compactionOverlay = null;
        }
      }, 400);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Streaming
  // Token-by-token rendering flow:
  //   1. _startStreamingCard() — create a StreamingMessageDelegate and a "Thinking..." status
  //   2. _appendToken() — append each token to the streaming delegate, scroll to bottom
  //   3. _finalizeStreaming() — force final markdown render, remove streaming elements,
  //      then rebuild the ENTIRE message list from agent.state.messages.
  // We rebuild on finalize because the agent may have interleaved think/tool cards
  // during streaming that need to appear in correct chronological order.
  // ═══════════════════════════════════════════════════════════════════

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
    } as any);
    this._streamingDelegate = sd;
    this._streamingEl = sd.element;
    this._appendToFlow(this._streamingEl);
    if (!this._statusEl) {
      const status = new StatusDelegate('Thinking...');
      this._statusEl = status.element;
      this._appendToFlow(status.element);
    }
  }

  private _appendToken(token: string): void {
    if (this._streamingDelegate && this._streamingEl) {
      this._streamingDelegate.appendToken(this._streamingEl, token);
      this._scrollToBottom();
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
    if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
    this._inputPanel.setStreaming(false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Message rendering
  //
  // _appendCard is the main rendering entry point. It dispatches by msg.type
  // to the correct Delegate class. Each delegate wraps a DOM element.
  //
  // _updateCard handles in-place updates for live cards:
  //   - tool_call: toggle running → done animation, append duration, show output
  //   - think: append text body, update elapsed time
  //   - delegation_activity / status: replace entire card
  //
  // _delegateEls tracks every card by message.id so we can find and update.
  // ═══════════════════════════════════════════════════════════════════

  /** Dispatch msg.type to the correct delegate, insert into flow, track by id. */
  private _appendCard(msg: any): void {
    console.log('[Sessions] appendCard type:', msg.type || msg.role, 'id:', msg.id);
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
        // AskUserQuestion gets a special interactive card, Edit gets a diff view,
        // all other tool calls use the generic ToolActivityDelegate
        if (msg.toolName === 'AskUserQuestion' && msg.toolInput) {
          const onSendAnswer = (answer: string) => {
            if (!this._activeAgent) return;
            const convVM = App.getInstance().conversationVM;
            convVM.inputValue = answer;
            this._activeAgent.sendMessage(answer, convVM.permissionMode, convVM.effortMode, []).catch(() => {});
            convVM.inputValue = '';
          };
          const askCard = AskUserQuestionCard.build(msg, this._answeredAskIds, onSendAnswer);
          delegate = { element: askCard };
        } else if (msg.toolName === 'Edit' && msg.status === 'success' && msg.toolInput) {
          const filePath = (msg.toolInput as any).file_path || '';
          const oldStr = (msg.toolInput as any).old_string || '';
          const newStr = (msg.toolInput as any).new_string || '';
          delegate = new EditResultDelegate(filePath, oldStr, newStr, true);
        } else {
          // Try ToolCardRegistry for a custom card, fall back to generic ToolActivityDelegate
          const CardCtor = toolCardRegistry.get(msg.toolName) as any;
          if (CardCtor) {
            delegate = new CardCtor({
              toolName: msg.toolName || '',
              toolInput: msg.toolInput || {},
              status: (msg.status === 'pending' ? 'running' : msg.status === 'error' ? 'error' : 'success'),
              result: msg.content || undefined,
              durationMs: msg.durationMs,
            });
          } else {
            const state: ToolActivityState = {
              toolName: msg.toolName || '',
              toolInput: msg.toolInput || {},
              status: (msg.status === 'pending' ? 'running' : msg.status === 'error' ? 'error' : 'success'),
              result: msg.content || undefined,
              durationMs: msg.durationMs,
            };
            delegate = new ToolActivityDelegate(state);
          }
        }
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
        // <task-notification> arrives as a JSON message from the backend
        let data: { subSessionId?: string; subAgentId?: string; status?: string; summary?: string; result?: string } = {};
        try { data = JSON.parse(msg.content || '{}'); } catch {}
        delegate = new TaskNotificationDelegate({
          subSessionId: data.subSessionId || msg.taskId || '',
          subAgentId: data.subAgentId || msg.parentAgentId || '',
          status: (msg.taskStatus === 'failed' ? 'failed' : 'completed') as 'completed' | 'failed',
          summary: msg.taskSummary || '',
          result: msg.taskResult || '',
        });
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
        // Fallback: dispatch by role if type is unknown
        if (msg.role === 'user') {
          delegate = new UserMessageDelegate(msg);
        } else if (msg.role === 'assistant') {
          delegate = new AgentMessageDelegate(msg);
        }
        break;
    }

    if (delegate) {
      const msgId = (msg as any).id as string | undefined;
      if (msgId) {
        // Replace any existing card with the same id (e.g. re-render)
        const old = this._delegateEls.get(msgId);
        if (old) old.remove();
        this._delegateEls.set(msgId, delegate.element);
      }

      if (msgType === 'status') {
        // Status cards are pinned at the bottom, just above the sentinel
        if (this._statusEl) this._statusEl.remove();
        this._statusEl = delegate.element;
        this._flowInner.insertBefore(delegate.element, this._sentinel);
      } else {
        // While streaming, insert non-text cards (think, tool) BEFORE the
        // streaming delegate so they appear above the current text in the flow.
        // When not streaming, just append before the sentinel.
        if (this._streamingEl && this._streamingEl.parentElement === this._flowInner) {
          this._flowInner.insertBefore(delegate.element, this._streamingEl);
        } else {
          this._flowInner.insertBefore(delegate.element, this._sentinel);
        }
        // Ensure status card stays pinned at the very bottom
        if (this._statusEl && this._statusEl.parentElement === this._flowInner) {
          this._flowInner.insertBefore(this._statusEl, this._sentinel);
        }
      }
      this._scrollToBottom();
    }
  }

  /** Update a card in-place without rebuilding the entire flow.
   *  Maps msg.type to the appropriate DOM mutation strategy. */
  private _updateCard(msg: any): void {
    const msgId = (msg as any).id as string | undefined;
    if (!msgId) return;
    const oldEl = this._delegateEls.get(msgId);
    if (!oldEl) { this._appendCard(msg); return; }

    let delegate: { element: HTMLElement } | null = null;
    const msgType: string = msg.type || '';
    switch (msgType) {
      case 'tool_call':
        {
          // Mutate the existing tool card's DOM in-place:
          // - Update the status dot (color + animation)
          // - Append duration text when done
          // - Show/hide the output body
          const dot = oldEl.querySelector('span:first-of-type') as HTMLElement | null;
          const isRunning = (msg as any).status === 'pending';
          if (dot) {
            dot.style.animation = isRunning ? 'ta-pulse 2s ease-in-out infinite' : 'none';
            dot.style.opacity = isRunning ? '' : (msg.status === 'error' ? '0.4' : '0.2');
            dot.style.background = isRunning ? 'rgba(255,255,255,0.3)' : (msg.status === 'error' ? 'rgba(255,130,130,0.4)' : 'rgba(255,255,255,0.2)');
          }
          if (typeof msg.durationMs === 'number') {
            const durEls = oldEl.querySelectorAll('span');
            for (const s of durEls) {
              if (s.textContent?.includes('ms') || s.textContent?.includes('s')) {
                s.textContent = `· ${msg.durationMs >= 1000 ? `${(msg.durationMs / 1000).toFixed(1)}s` : `${msg.durationMs}ms`}`;
                break;
              }
            }
          }
          if (!isRunning && msg.content) {
            // Tool completed — replace basic ToolActivityDelegate with rich ToolResultDelegate
            // that shows token usage, tool-specific summary, collapse/expand, stderr detection
            const resultDelegate = new ToolResultDelegate({
              type: 'tool_result',
              toolName: msg.toolName || '',
              content: msg.content || '',
              isError: msg.status === 'error',
              summary: undefined, // ToolResultDelegate auto-generates summary via generateSummary()
              durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : undefined,
            });
            oldEl.replaceWith(resultDelegate.element);
            this._delegateEls.set(msgId, resultDelegate.element);
          } else if (!isRunning) {
            // Tool completed with no content — hide body
            const bodyEl = oldEl.querySelector('pre') as HTMLElement | null;
            if (bodyEl) bodyEl.hidden = true;
          } else {
            if (msg.content) {
              let bodyEl = oldEl.querySelector('pre') as HTMLElement | null;
              if (!bodyEl) {
                bodyEl = document.createElement('pre');
                bodyEl.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.35);line-height:1.6;padding:8px 0;margin-bottom:12px;white-space:pre-wrap;word-break:break-all;font-family:var(--font-mono,monospace);border-bottom:1px solid var(--hairline-cinema,rgba(255,255,255,0.06));';
                oldEl.appendChild(bodyEl);
                const indicator = oldEl.querySelector('div') as HTMLElement | null;
                if (indicator) {
                  indicator.style.cursor = 'pointer';
                  indicator.addEventListener('click', () => { if (bodyEl) bodyEl.hidden = !bodyEl.hidden; });
                }
              }
              bodyEl.textContent = msg.content.length > 200 || msg.content.split('\n').length > 5 ? msg.content.slice(0, 400) : msg.content;
              bodyEl.hidden = false;
            }
          }
        }
        break;
      case 'delegation_activity':
        {
          // Update content span in-place — never rebuild the card
          const indicator = oldEl.firstElementChild as HTMLElement | null;
          if (indicator && indicator.children.length >= 4) {
            const contentSpan = indicator.children[3] as HTMLElement;
            const newContent = msg.content || '';
            if (contentSpan.textContent !== newContent) {
              contentSpan.textContent = newContent;
            }
          }
        }
        break;
      case 'think':
        {
          const bodyEl = oldEl.querySelector('.cinema-think-body');
          if (bodyEl) bodyEl.textContent = msg.content || '';
          const labelEl = oldEl.querySelector('.cinema-think-indicator span:last-child');
          if (labelEl && msg.durationMs) labelEl.textContent = `THINKING · ${((msg.durationMs as number) / 1000).toFixed(1)}s`;
          if ((msg as any).status !== 'pending') {
            const dot = oldEl.querySelector('.cinema-pulse-dot') as HTMLElement | null;
            if (dot) { dot.style.animation = 'none'; dot.style.opacity = '0.3'; }
          }
        }
        break;
      case 'task_notification':
        {
          // In-place status update — never rebuild the card
          let tData: { status?: string; summary?: string; result?: string; taskId?: string; parentAgentId?: string } = {};
          try { tData = JSON.parse(msg.content || '{}'); } catch {}
          const tStatus = (tData.status === 'failed' ? 'failed' : 'completed') as string;
          if (oldEl.getAttribute('data-status') !== tStatus) {
            oldEl.setAttribute('data-status', tStatus);
            const borderColor = tStatus === 'completed'
              ? 'var(--color-success, #4ade80)'
              : 'var(--color-error, #f87171)';
            oldEl.style.borderLeftColor = borderColor;
          }
          const tHeader = oldEl.firstElementChild as HTMLElement | null;
          if (tHeader) {
            const tAgentName = tData.parentAgentId || 'sub-agent';
            const newHeaderText = `${tStatus === 'completed' ? 'Task completed' : 'Task failed'}: ${tAgentName} — ${tData.summary || ''}`;
            if (tHeader.textContent !== newHeaderText) {
              tHeader.textContent = newHeaderText;
            }
          }
          const tBody = oldEl.children[1] as HTMLElement | null;
          if (tBody && tData.result) {
            const newBody = tData.result.slice(0, 500);
            if (tBody.textContent !== newBody) {
              tBody.textContent = newBody;
            }
          }
        }
        break;
      case 'status':
        delegate = new StatusDelegate(msg.content);
        break;
      default:
        break;
    }
    if (delegate && delegate.element) {
      oldEl.replaceWith(delegate.element);
      this._delegateEls.set(msgId, delegate.element);
      if (msgType === 'status') this._statusEl = delegate.element;
    }
  }

  private _removeCard(msgId: string): void {
    const el = this._delegateEls.get(msgId);
    if (el) { el.remove(); this._delegateEls.delete(msgId); }
    if (this._statusEl && msgId === 'status-indicator') this._statusEl = null;
  }

  /** Clear the flow and rebuild all cards from agent.state.messages.
   *  Used on session switch and history load. */
  private _renderHistory(): void {
    this._clearFlow();
    this._hideWelcome();
    // Reset all streaming/bookkeeping state
    this._streamingDelegate = null;
    this._streamingEl = null;
    if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
    const messages = this._activeAgent?.state.messages.messages || [];
    for (const msg of messages) this._appendCard(msg);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Overfly panels
  // ═══════════════════════════════════════════════════════════════════

  private _showInlineCard(panel: string): void {
    if (!this._activeSessionId) return;
    this._overfly.show(panel, this._activeSessionId, this._workspacePath);
    this._rightBar.setActivePanel(panel);
  }

  private _closeOverfly(): void {
    console.log('[Sessions] overfly close');
    this._overfly.close();
    this._rightBar.setActivePanel(null);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

  private _appendToFlow(el: HTMLElement): void {
    this._flowInner.insertBefore(el, this._sentinel);
  }

  /** Remove all message cards from the flow, keeping welcome + sentinel. */
  private _clearFlow(): void {
    this._delegateEls.clear();
    this._statusEl = null;
    this._loadingEl = null;
    this._streamingDelegate = null;
    this._streamingEl = null;
    const children = Array.from(this._flowInner.children);
    for (const child of children) {
      if (child !== this._welcomeEl && child !== this._sentinel) child.remove();
    }
  }

  /** Scroll to the latest message — only if user hasn't scrolled up to read history.
   *  Uses rAF to batch with DOM paint. Re-checks _autoScroll inside rAF
   *  because scroll state may have changed between call and frame. */
  private _scrollToBottom(): void {
    if (!this._autoScroll) return;
    requestAnimationFrame(() => {
      if (!this._autoScroll) return; // re-check: user may have scrolled up since call
      this._flowEl.scrollTop = this._flowEl.scrollHeight;
    });
  }

  /** Force auto-scroll back on — called when user sends a new message. */
  private _resetAutoScroll(): void {
    this._autoScroll = true;
  }
}
