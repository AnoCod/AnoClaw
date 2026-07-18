// AnoClaw Frontend — Application Bootstrap
// Entry point. Initializes theme, navigation, page routing, WS client, ViewModels.

import { pageRegistry } from './PageRegistry.js';
import { TitleBar } from './components/TitleBar.js';
import { WSClient, WSConnectionState } from './viewmodel/WSClient.js';
import { ConversationViewModel } from './viewmodel/ConversationViewModel.js';
import { SessionViewModel } from './viewmodel/SessionViewModel.js';
import { AgentViewModel } from './viewmodel/AgentViewModel.js';
import { WSMessageRouter } from './viewmodel/WSMessageRouter.js';
import { registerChatHandlers } from './handlers/ChatHandlers.js';
import { SessionsPage } from './components/pages/SessionsPage.js';
import { AgentsPage } from './components/pages/AgentsPage.js';
import { SkillsPage } from './components/pages/SkillsPage.js';
import { MemoryPage } from './components/pages/MemoryPage.js';
import { SettingsPage } from './components/pages/SettingsPage.js';
import { WorkspacePage } from './components/pages/workspace/WorkspacePage.js';
import { PluginsPage } from './components/pages/PluginsPage.js';
import { PluginPageContainer } from './components/pages/PluginPageContainer.js';
import { PluginViewModel } from './viewmodel/PluginViewModel.js';
import { ToolConfirmationQueue } from './viewmodel/ToolConfirmationQueue.js';
import {
  combineFloatingBallWaiting,
  summarizeAskUserWaiting,
  type AskUserSessionMessages,
  type FloatingBallWaitingSnapshot,
} from './viewmodel/FloatingBallWaiting.js';
import type { AppSettings, PluginPageContribution, SessionNode } from './types.js';
import type { GoalState } from './components/conversation/types.js';
import { ClientLogger } from './ClientLogger.js';
import { initAnoClawAPI } from './anoclaw-api.js';
import { localeDirection, normalizeLocale, setLocale } from './i18n/index.js';
import { normalizeUserMode } from './userMode.js';

const SETTINGS_KEY = 'anoclaw-settings';
const FLOATING_BALL_ACTIVITY_LIMIT = 6;
const FLOATING_BALL_ACTIVITY_PHASE_MS = 10 * 60 * 1000;

const DEFAULT_SETTINGS: AppSettings = {
  lang: 'zh-CN',
  userMode: 'simple',
  showThinkCards: true,
  showToolCards: true,
  theme: 'dark',
  accentColor: '#0b8ce9',
  compactionThreshold: 70,
};

type FloatingBallActivityStatus = 'completed' | 'failed';

interface FloatingBallActivityItem {
  id: string;
  sessionId: string | null;
  title: string;
  detail?: string;
  status: FloatingBallActivityStatus;
  timestamp: number;
}

type FloatingBallNoticeKind = 'info' | 'success' | 'error';
type FloatingBallPhase = 'thinking' | 'tool' | 'waiting' | 'done' | 'failed' | 'idle' | 'goal' | 'paused';
type FloatingBallGoalStatus = GoalState['status'] | 'blocked' | 'completed';

interface FloatingBallGoalPulse {
  sessionId: string | null;
  status: FloatingBallGoalStatus;
  objective: string;
  runCount?: number;
  updatedAt?: string;
  lastRunAt?: string;
}

/**
 * Singleton App class — the frontend bootstrap.
 *
 * Init sequence:
 * 1. Connect WebSocket (single global connection)
 * 2. Apply theme from localStorage
 * 3. Mount TitleBar
 * 4. Register all pages via PageRegistry
 * 5. Load sessions → restore active session
 * 6. Load agents, plugins → sync plugin pages into navigation
 * 7. Wire WS events: WSClient → WSMessageRouter → ChatHandlers → ConversationViewModel
 * 8. Set up hash-based routing, floating-ball listeners, resize flag
 *
 * Settings: persisted to localStorage, synced to server via PUT /api/v1/settings/ui.
 * Theme: data-theme + data-accent attributes on <html>, CSS variables handle rest.
 */
class App {
  private static _instance: App;

  private _settings: AppSettings;
  private _sseClient: WSClient;
  private _conversationVM: ConversationViewModel;
  private _sessionVM: SessionViewModel;
  private _agentVM: AgentViewModel;
  private _titleBar: TitleBar;
  private _pluginVM: PluginViewModel;
  private _registeredPluginPages: string[] = [];
  private _pendingNav: string | null = null;
  private _floatingBallStateTimer: ReturnType<typeof setTimeout> | null = null;
  private _floatingBallActivity: FloatingBallActivityItem[] = [];

  private constructor() {
    this._settings = this._loadSettings();
    this._sseClient = new WSClient();
    this._conversationVM = new ConversationViewModel();
    this._sessionVM = new SessionViewModel(this._sseClient);

    // Wire WSClient events to ConversationViewModel
    this._conversationVM.setSessionVM(this._sessionVM);
    this._agentVM = new AgentViewModel();
    this._sessionVM.setAgentVM(this._agentVM);
    this._titleBar = new TitleBar();
    this._pluginVM = new PluginViewModel();

    // Initialize anoclaw UI API (components, registry, slots)
    initAnoClawAPI();

    // Wire WebSocket events to domain ViewModels
    this._wireWS();
  }

  static getInstance(): App {
    if (!App._instance) {
      App._instance = new App();
    }
    return App._instance;
  }

  async init(): Promise<void> {
    console.log('[App] init() called');
    ClientLogger.app.info('Frontend initializing');
    console.log('[AnoClaw] Initializing frontend...');

    this._applyPreferences();

    // Connect WebSocket once at init (single global connection, not per-session)
    this._sseClient.connect();

    // Mount titlebar (index.html has a #titlebar shell, we swap content)
    const titlebarEl = document.getElementById('titlebar');
    if (titlebarEl) {
      titlebarEl.innerHTML = '';
      titlebarEl.appendChild(this._titleBar.element);
    }

    // Page registration — each page creates its container, appended to #page-area
    this._setupPageContainer();

    // Wire sessionSelected → activeSessionChanged BEFORE restoreActiveSession fires
    this._sessionVM.on('sessionSelected', (node: unknown) => {
      const n = node as { id: string };
      this._conversationVM.setActiveSession(n.id);
    });

    // Load sessions first — restoreActiveSession picks up last open session
    try {
      await this._sessionVM.loadSessions();
      // After page refresh, automatically restore the last open session
      this._sessionVM.restoreActiveSession();
    } catch (e) {
      ClientLogger.app.error('Failed to load sessions', { error: (e as Error).message });
    }

    // If sessions empty after load, retry with exponential backoff (server may be restarting)
    if (this._sessionVM.sessions.tree.length === 0) {
      this._retryLoadSessions(0);
    }
    this._agentVM.loadAgents().catch((e) => ClientLogger.app.error('Failed to load agents', { error: (e as Error).message }));

    // Load plugins + sync contributed pages into TitleBar PAGES dropdown
    this._pluginVM.load().then(() => {
      this._syncPluginPages();
      this._pluginVM.on('pluginsChanged', () => this._syncPluginPages());
    }).catch(() => {});

    // Server restart detection: WS sends serverEpoch on connect. If changed, reload all state.
    const ws = this._sessionVM.getWSClient();
    ws.on('serverRestarted', () => {
      ClientLogger.app.info('Server epoch changed — reloading all state');
      this._syncSettingsFromServer();
      this._sessionVM.loadSessions().then(() => {
        this._sessionVM.restoreActiveSession();
      }).catch(() => {});
      this._agentVM.loadAgents().catch(() => {});
      this._pluginVM.load().catch(() => {});
    });

    // WS reconnected after disconnect → auto-recover stale state
    ws.on('reconnected', () => {
      ClientLogger.app.info('WS reconnected — refreshing state');
      this._syncSettingsFromServer();
      // Recover already-known sessions immediately, then repeat after the
      // session list refresh so buffered events routed during reconnect join in.
      this._conversationVM.reconcileAfterReconnect();
      this._sessionVM.loadSessions().then(() => {
        this._sessionVM.restoreActiveSession();
        this._conversationVM.reconcileAfterReconnect();
      }).catch(() => {});
      this._agentVM.loadAgents().catch(() => {});
    });

    // Plugin file watcher auto-reload → refresh plugin list and navigation
    ws.on('pluginsChanged', () => {
      ClientLogger.app.info('Plugins changed — reloading plugin list');
      this._pluginVM.load().catch(() => {});
    });
    window.addEventListener('anoclaw:plugins-changed', () => {
      ClientLogger.app.info('Plugin action completed — reloading plugin list');
      this._pluginVM.load().catch(() => {});
    });

    // Navigate to page from URL hash, default to workspace (sessions always visible on right)
    this._setupHashNav();
    this._setupFloatingBallBridge();
    if (window.location.hash) {
      const page = window.location.hash.slice(1);
      if (page === 'sessions' || pageRegistry.getPage(page)) this.navigateTo(page);
      else this.navigateTo('workspace');
    } else {
      this.navigateTo('workspace');
    }

    console.log('[AnoClaw] Frontend initialized.');
    ClientLogger.app.info('Frontend initialized');
    // Expose for browser tab features
    (window as any).__anoclawApp = this;

    // Resize: flag <html> with .is-resizing for CSS GPU compositing optimizations
    let rt: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('resize', () => {
      document.documentElement.classList.add('is-resizing');
      if (rt) clearTimeout(rt);
      rt = setTimeout(() => {
        document.documentElement.classList.remove('is-resizing');
        rt = null;
      }, 200);
    });
  }

  /** Navigate to a page by name. Defer to _pendingNav if page not yet registered. */
  navigateTo(page: string): void {
    console.log('[App] navigateTo:', page);
    if (page === 'sessions') {
      // Sessions always visible on right — no-op for navigation
      return;
    }
    if (pageRegistry.getPage(page)) {
      pageRegistry.navigateTo(page);
      this._titleBar.setPageName(page);
      this._pendingNav = null;
    } else {
      this._pendingNav = page;
    }
    if (window.location.hash !== '#' + page) {
      history.replaceState(null, '', '#' + page);
    }
  }

  private _setupHashNav(): void {
    // Listen for hash changes (browser back/forward) + TitleBar nav events + floating-ball events
    window.addEventListener('hashchange', () => {
      const page = window.location.hash.slice(1);
      if (page) this.navigateTo(page);
    });

    // TitleBar page switcher events
    window.addEventListener('navigate-to', ((e: CustomEvent) => {
      const page = e.detail?.page;
      if (page) this.navigateTo(page);
    }) as EventListener);

    // Floating ball — new session
    window.addEventListener('floating-ball-new-session', () => {
      this.navigateTo('sessions');
      this._sessionVM.createSession(undefined, undefined).catch(() => {});
    });

    // Floating ball — open a recent session.
    window.addEventListener('floating-ball-open-session', ((e: CustomEvent) => {
      this.navigateTo('sessions');
      const detail = (e.detail || {}) as { sessionId?: string; index?: number };
      if (detail.sessionId) {
        this._sessionVM.selectSession(detail.sessionId);
      }
    }) as EventListener);
  }

  // -- Getters for shared singletons --

  get settings(): AppSettings {
    return { ...this._settings };
  }

  get sseClient(): WSClient {
    return this._sseClient;
  }

  get conversationVM(): ConversationViewModel {
    return this._conversationVM;
  }

  get sessionVM(): SessionViewModel {
    return this._sessionVM;
  }

  get agentVM(): AgentViewModel {
    return this._agentVM;
  }

  // -- Settings --

  /** Save settings to localStorage (fast-path cache) + fire-and-forget PUT to server. */
  updateSettings(patch: Partial<AppSettings>): void {
    console.log('[App] updateSettings:', JSON.stringify(patch));
    Object.assign(this._settings, patch);
    this._settings = this._normalizeSettings(this._settings);
    this._saveSettings();
    this._applyPreferences();

    window.dispatchEvent(new CustomEvent('settings-changed', {
      detail: { ...this._settings },
    }));
  }

  // -- Private --

  /** Load settings from localStorage, merging over defaults. */
  private _loadSettings(): AppSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        return this._normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      }
    } catch (e) {
      ClientLogger.app.warn('Failed to load settings, using defaults', { error: (e as Error).message });
    }
    return { ...DEFAULT_SETTINGS };
  }

  /** Pull latest settings from server, merge only if changed. Swallows errors (server may be down). */
  private async _syncSettingsFromServer(): Promise<void> {
    try {
      const resp = await fetch('/api/v1/settings/ui');
      if (!resp.ok) return;
      const server = await resp.json() as Partial<AppSettings>;
      // Only override if server has newer data; localStorage is the fast-path cache
      const changed = Object.keys(server).some(
        (k) => (server as unknown as Record<string, unknown>)[k] !== (this._settings as unknown as Record<string, unknown>)[k]
      );
      if (changed) {
        this._settings = this._normalizeSettings({ ...this._settings, ...server });
        this._applyPreferences();
        window.dispatchEvent(new CustomEvent('settings-changed', {
          detail: { ...this._settings },
        }));
      }
    } catch {
      // Server unavailable — use localStorage values, they'll sync next time
    }
  }

  private _saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings));
    } catch (e) {
      ClientLogger.app.warn('Failed to save settings', { error: (e as Error).message });
    }
    // Fire-and-forget PUT to server for persistence
    fetch('/api/v1/settings/ui', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this._settings),
    }).catch(() => {});
  }

  private _normalizeSettings(settings: Partial<AppSettings>): AppSettings {
    const accentColor = this._normalizeAccentColor((settings as { accentColor?: unknown }).accentColor);
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      lang: normalizeLocale((settings as { lang?: unknown }).lang),
      userMode: normalizeUserMode((settings as { userMode?: unknown }).userMode),
      theme: settings.theme === 'light' ? 'light' : 'dark',
      accentColor,
    };
  }

  private _normalizeAccentColor(value: unknown): string {
    if (typeof value !== 'string') return DEFAULT_SETTINGS.accentColor;
    const normalized = value.trim();
    if (!normalized) return DEFAULT_SETTINGS.accentColor;
    if (normalized.toLowerCase() === '#ffffff') return DEFAULT_SETTINGS.accentColor;
    if (normalized.toLowerCase() === '#0984e3') return DEFAULT_SETTINGS.accentColor;
    if (normalized.toLowerCase() === '#57c1ff') return DEFAULT_SETTINGS.accentColor;
    return normalized;
  }

  private _applyPreferences(): void {
    this._applyTheme();
    this._applyLocale();
  }

  /** Set data-theme and data-accent attributes on <html> for CSS variable switching. */
  private _applyTheme(): void {
    console.log('[App] _applyTheme: theme=' + this._settings.theme + ', accent=' + this._settings.accentColor);
    const root = document.documentElement;
    root.setAttribute('data-theme', this._settings.theme);
    const accentName = this._getAccentName(this._settings.accentColor);
    root.setAttribute('data-accent', accentName);
    root.style.setProperty('--user-accent', this._settings.accentColor);
    root.style.removeProperty('--color-accent');
    root.style.removeProperty('--color-accent-hover');
    root.style.removeProperty('--color-on-accent');
    root.style.removeProperty('--color-icon-active');
    root.style.removeProperty('--color-accent-cinema');
    root.style.removeProperty('--color-accent-cinema-subtle');
    root.style.removeProperty('--color-accent-cinema-glow');
    window.dispatchEvent(new CustomEvent('theme-changed', {
      detail: { theme: this._settings.theme, accent: accentName },
    }));
  }

  private _applyLocale(): void {
    const locale = setLocale(this._settings.lang);
    this._settings.lang = locale;
    const root = document.documentElement;
    root.lang = locale;
    root.dir = localeDirection(locale);
    window.dispatchEvent(new CustomEvent('locale-changed', {
      detail: { locale },
    }));
  }

  private _getAccentName(hex: string): string {
    const map: Record<string, string> = {
      '#ffffff': 'blue',
      '#ff6161': 'red',
      '#da291c': 'red',
      '#0b8ce9': 'blue',
      '#57c1ff': 'blue',
      '#0984e3': 'blue',
      '#59d499': 'green',
      '#00b894': 'green',
      '#ffc533': 'orange',
      '#e17055': 'orange',
      '#a78bfa': 'purple',
      '#7c3aed': 'purple',
    };
    return map[hex.trim().toLowerCase()] || 'blue';
  }

  /** Create #page-area + #sessions-panel inside #page-container, instantiate and register all kernel pages. */
  private _setupPageContainer(): void {
    const container = document.getElementById('page-container');
    if (!container) {
      ClientLogger.app.error('Page container not found in DOM');
      return;
    }

    // Left panel: page area (Agents, Skills, Memory, Settings, Plugins)
    const pageArea = document.getElementById('page-area');
    if (!pageArea) {
      ClientLogger.app.error('Page area not found in DOM');
      return;
    }

    // Right panel: sessions — always visible
    const sessionsPanel = document.getElementById('sessions-panel');
    if (!sessionsPanel) {
      ClientLogger.app.error('Sessions panel not found in DOM');
      return;
    }

    // Wire split handle resize
    const handle = document.getElementById('layout-split-handle');
    if (handle && pageArea) this._wireSplitHandle(handle, pageArea);

    // SessionsPage lives in right panel, always visible — never registered in pageRegistry
    const sessionsPage = new SessionsPage();
    sessionsPanel.appendChild(sessionsPage.container);
    // Call onEnter-style setup once (SessionsPage no longer managed by PageRegistry lifecycle)
    sessionsPage.onEnter();

    // Left panel pages — managed by PageRegistry hide/show
    const pages = [
      new WorkspacePage(),
      new AgentsPage(),
      new SkillsPage(),
      new MemoryPage(),
      new SettingsPage(),
      new PluginsPage(this._pluginVM),
    ];

    for (const page of pages) {
      pageArea.appendChild(page.container);
      pageRegistry.register(page);
    }
  }

  /** Wire mousedown-based split handle dragging for #layout-split-handle. */
  private _wireSplitHandle(handle: HTMLElement, pageArea: HTMLElement): void {
    let dragging = false;
    const cssPx = (name: string, fallback: number): number => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const applySplit = (desiredPct: number): void => {
      const container = document.getElementById('page-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const usable = Math.max(0, rect.width - handle.offsetWidth);
      if (usable <= 0) return;
      const minPage = cssPx('--page-area-min-width', 300);
      const minSessions = cssPx('--sessions-panel-min-width', 340);
      const desiredPx = usable * (desiredPct / 100);
      const maxPage = Math.max(0, usable - minSessions);
      const minPageWhenPossible = Math.min(minPage, maxPage);
      const clampedPx = Math.min(maxPage, Math.max(minPageWhenPossible, desiredPx));
      pageArea.style.flex = `0 0 ${Math.round(clampedPx)}px`;
    };
    const clampCurrent = (): void => {
      const container = document.getElementById('page-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const usable = Math.max(1, rect.width - handle.offsetWidth);
      const currentPct = (pageArea.getBoundingClientRect().width / usable) * 100;
      applySplit(currentPct);
    };
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const container = document.getElementById('page-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const rawPct = ((e.clientX - rect.left) / rect.width) * 100;
      const pct = Math.min(70, Math.max(25, rawPct));
      applySplit(pct);
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
    window.addEventListener('resize', () => {
      if (dragging) return;
      requestAnimationFrame(clampCurrent);
    });
  }

  /** Sync plugin-contributed pages to TitleBar PAGES dropdown and PageRegistry. */
  private _syncPluginPages(): void {
    const entries: Array<{ page: string; label: string }> = [];
    entries.push({ page: 'plugins', label: 'Plugins' });

    const pageArea = document.getElementById('page-area');
    if (!pageArea) return;

    // Build set of current plugin page names for diffing (add/remove)
    const currentNames = new Set(this._pluginVM.pageContributions.map(c => c.id));

    // Remove stale plugin pages that no longer exist in the current plugin list
    let removedCurrent = false;
    const kept = new Set<string>();
    for (const name of this._registeredPluginPages) {
      if (!currentNames.has(name)) {
        const old = pageRegistry.getPage(name);
        if (old) {
          const wasCurrent = pageRegistry.currentPage === name;
          old.container.remove();
          old.onExit();
          if (wasCurrent) removedCurrent = true;
        }
      } else {
        kept.add(name);
      }
    }

    // Add new plugin pages (not already registered)
    for (const c of this._pluginVM.pageContributions) {
      entries.push({ page: c.id, label: c.title });
      if (!kept.has(c.id) && c.htmlPath) {
        const pluginPage = new PluginPageContainer(c);
        pageArea.appendChild(pluginPage.container);
        pageRegistry.register(pluginPage);
      }
    }

    this._registeredPluginPages = this._pluginVM.pageContributions.map(c => c.id);
    this._titleBar.setPluginPages(entries);

    // Re-check hash — may need to navigate to a newly available plugin page
    const hash = window.location.hash.slice(1);
    if (hash && pageRegistry.getPage(hash) && pageRegistry.currentPage !== hash) {
      pageRegistry.navigateTo(hash);
      this._titleBar.setPageName(hash);
    }

    // Retry any navigation that was deferred because the target page wasn't registered yet
    if (this._pendingNav && pageRegistry.getPage(this._pendingNav) && pageRegistry.currentPage !== this._pendingNav) {
      pageRegistry.navigateTo(this._pendingNav);
      this._titleBar.setPageName(this._pendingNav);
      this._pendingNav = null;
    }
  }

  /**
   * Retry loading sessions with exponential backoff: 1s, 2s, 4s, 8s, 10s (capped), up to 8 retries.
   * Handles server restart during page load.
   */
  private _retryLoadSessions(attempt: number): void {
    if (attempt >= 8) return;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    setTimeout(async () => {
      try {
        await this._sessionVM.loadSessions();
        if (this._sessionVM.sessions.tree.length > 0) {
          this._sessionVM.restoreActiveSession();
          return;
        }
      } catch { /* server still down, retry */ }
      this._retryLoadSessions(attempt + 1);
    }, delay);
  }

  /** Wire WS events to TitleBar (connection state), ConversationViewModel (messages), and AgentViewModel. */
  private _wireWS(): void {
    // Connection state changes → update TitleBar status dot
    this._sseClient.on('connectionStateChanged', (state: unknown) => {
      this._titleBar.setConnectionState(state as WSConnectionState);
      this._scheduleFloatingBallStateUpdate();
    });

    // WS connection lost → clean up streaming state
    this._sseClient.on('connectionLost', () => {
      this._conversationVM.onConnectionLost();
    });

    // Pluggable message router: WSClient 'event' → WSMessageRouter.dispatch → ChatHandlers
    const router = new WSMessageRouter();
    registerChatHandlers(router, this._conversationVM, this._sessionVM);

    // Wire ToolConfirmationQueue to WS client
    const toolConfirmQueue = ToolConfirmationQueue.getInstance();
    toolConfirmQueue.setSender((data) => this._sseClient.send(data));
    toolConfirmQueue.setAutoApprover((request) => this._conversationVM.hasActiveGoalForSession(request.sessionId));
    toolConfirmQueue.onChange(() => this._scheduleFloatingBallStateUpdate());

    // Every received WS message → dispatch by type. session-less events pass empty sessionId.
    this._sseClient.on('event', (data: unknown) => {
      const d = data as { type: string; data: Record<string, unknown>; sessionId: string };
      console.log('[App] WS event received, dispatching:', d.type, 'sessionId:', d.sessionId);
      // Events not tied to a specific session (sessionId empty) go through as-is
      router.dispatch(d.type, d.data || {}, d.sessionId || '');
      this._recordFloatingBallActivity(d.type, d.data || {}, d.sessionId || '');
      this._scheduleFloatingBallStateUpdate();
    });

    // On page close/refresh, let the WS disconnect naturally.
    // Sending a stop signal on beforeunload causes "(User aborted during API call)"
    // to be persisted and shown on reload — misleading since the user didn't abort.
    // The server continues running and persists all events; history loads correctly.

    // Subscribe AgentViewModel to real-time agent status/lifecycle events via WS
    this._agentVM.subscribeToAgentEvents(this._sseClient);
  }

  private _setupFloatingBallBridge(): void {
    const api = (window as any).electronAPI;
    if (!api) return;

    if (api.onFloatingBallCommand) {
      api.onFloatingBallCommand((payload: { action?: string; data?: unknown }) => {
        this._handleFloatingBallCommand(payload).catch((err) => {
          ClientLogger.app.error('Floating ball command failed', { error: (err as Error).message });
          this._pushFloatingBallNotice('error', (err as Error).message || 'FloatingBall action failed');
        });
      });
    }

    const schedule = () => this._scheduleFloatingBallStateUpdate();
    this._sessionVM.on('sessionsLoaded', schedule);
    this._sessionVM.on('sessionAdded', schedule);
    this._sessionVM.on('sessionUpdated', schedule);
    this._sessionVM.on('sessionRemoved', schedule);
    this._sessionVM.on('sessionSelected', schedule);
    this._conversationVM.on('activeSessionChanged', schedule);
    this._conversationVM.on('permissionModeChanged', schedule);
    this._conversationVM.on('goalChanged', schedule);
    this._conversationVM.on('messagesChanged', schedule);
    window.addEventListener('focus', schedule);
    schedule();
  }

  private _scheduleFloatingBallStateUpdate(): void {
    if (this._floatingBallStateTimer) clearTimeout(this._floatingBallStateTimer);
    this._floatingBallStateTimer = setTimeout(() => {
      this._floatingBallStateTimer = null;
      this._pushFloatingBallState();
    }, 80);
  }

  private _pushFloatingBallState(): void {
    const api = (window as any).electronAPI;
    if (!api?.floatingBallUpdateState) return;

    const active = this._sessionVM.activeSession;
    const streamingIds = this._conversationVM.getStreamingSessionIds();
    const waitingSnapshot = combineFloatingBallWaiting(
      ToolConfirmationQueue.getInstance().snapshot,
      this._floatingBallAskUserSnapshot(),
    );
    const waitingItem = waitingSnapshot.first;
    const waitingCount = waitingSnapshot.count;
    const recentSessions = [...this._sessionVM.sessions.all]
      .sort((a, b) => new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime())
      .slice(0, 5)
      .map((session) => ({
        id: session.id,
        title: session.title || 'Session',
        status: this._conversationVM.isSessionStreaming(session.id) ? 'running' : (session.status || 'idle'),
      }));

    const waitingSessionId = waitingItem?.sessionId || null;
    const taskSessionId = waitingSessionId || active?.id || streamingIds[0] || null;
    const taskNode = taskSessionId ? this._sessionVM.sessions.getById(taskSessionId) : null;
    const goalPulse = this._floatingBallGoalSnapshot(
      [waitingSessionId, taskSessionId, active?.id, ...streamingIds],
      waitingSessionId,
      waitingCount,
    );
    const isRunning = taskSessionId ? this._conversationVM.isSessionStreaming(taskSessionId) : false;
    const latestActivity = this._recentFloatingBallActivity()[0] || null;
    const latestActivityIsFresh = latestActivity ? Date.now() - latestActivity.timestamp < FLOATING_BALL_ACTIVITY_PHASE_MS : false;
    const activityPhase = latestActivityIsFresh
      ? latestActivity?.status === 'failed' ? 'failed' : latestActivity?.status === 'completed' ? 'done' : 'idle'
      : 'idle';
    const goalPhase = goalPulse?.status === 'active'
      ? 'goal'
      : goalPulse?.status === 'paused'
        ? 'paused'
        : goalPulse?.status === 'blocked'
          ? 'waiting'
          : goalPulse?.status === 'completed'
            ? 'done'
            : null;
    const phase: FloatingBallPhase = waitingCount > 0
      ? 'waiting'
      : isRunning
        ? (goalPulse?.status === 'active' ? 'goal' : 'thinking')
        : goalPhase || activityPhase;
    const detail = waitingCount > 0
      ? waitingItem
        ? waitingItem.source === 'ask-user'
          ? 'Question needs your answer'
          : `${waitingItem.displayName} approval needed${waitingItem.riskLevel ? ` · ${waitingItem.riskLevel}` : ''}`
        : `${waitingCount} waiting`
      : goalPulse && goalPulse.status !== 'deleted'
        ? goalPulse.objective || (goalPulse.status === 'paused' ? 'Goal paused' : 'Active goal')
        : isRunning
          ? 'Agent is working'
          : latestActivityIsFresh && latestActivity
            ? latestActivity.title
            : 'Ready';

    api.floatingBallUpdateState({
      activeSessionId: active?.id || null,
      activeTitle: active?.title || null,
      connection: this._sseClient.connectionState,
      runningCount: streamingIds.length,
      waitingCount,
      recentSessions,
      activityItems: this._recentFloatingBallActivity().slice(0, 3),
      waitingInbox: waitingCount > 0 ? {
        count: waitingCount,
        sessionId: waitingSessionId,
        title: waitingItem
          ? waitingItem.source === 'ask-user'
            ? 'Question needs answer'
            : `${waitingItem.displayName} needs approval`
          : `${waitingCount} items need attention`,
        detail: waitingItem?.detail || detail,
        riskLevel: waitingItem?.riskLevel,
        toolCallId: waitingItem?.toolCallId,
        canInlineResolve: waitingItem?.canInlineResolve === true,
      } : undefined,
      goalPulse,
      currentTask: taskSessionId ? {
        sessionId: taskSessionId,
        title: taskNode?.title || active?.title || 'Session',
        phase,
        detail,
      } : undefined,
    });
  }

  private _recordFloatingBallActivity(type: string, data: Record<string, unknown>, fallbackSessionId: string): void {
    const sessionId = String((data.sessionId as string | undefined) || fallbackSessionId || '') || null;
    const idBase = `${type}-${sessionId || 'global'}-${Date.now()}`;
    let item: FloatingBallActivityItem | null = null;

    if (type === 'tool_execution_completed') {
      const toolName = String(data.toolName || 'Tool');
      const success = data.success !== false;
      const durationMs = Number(data.durationMs || 0);
      item = {
        id: `${idBase}-${toolName}`,
        sessionId,
        title: `${toolName} ${success ? 'completed' : 'failed'}`,
        detail: durationMs > 0 ? `${Math.round(durationMs / 100) / 10}s` : undefined,
        status: success ? 'completed' : 'failed',
        timestamp: Date.now(),
      };
    } else if (type === 'task_notification') {
      const rawStatus = String(data.taskStatus || data.status || 'completed');
      const failed = rawStatus === 'failed';
      const summary = String(data.taskSummary || data.summary || 'Background task');
      item = {
        id: `${idBase}-${String(data.taskId || '')}`,
        sessionId,
        title: failed ? 'Task failed' : 'Task completed',
        detail: summary,
        status: failed ? 'failed' : 'completed',
        timestamp: Date.now(),
      };
    } else if (type === 'command_result') {
      const command = String(data.command || 'Command');
      const success = data.success !== false;
      item = {
        id: `${idBase}-${command}`,
        sessionId,
        title: `${command} ${success ? 'completed' : 'failed'}`,
        detail: String(data.output || data.errorMessage || '').trim() || undefined,
        status: success ? 'completed' : 'failed',
        timestamp: Date.now(),
      };
    } else if (type === 'error') {
      item = {
        id: idBase,
        sessionId,
        title: 'Agent error',
        detail: String(data.message || data.error || data.content || 'Unknown error'),
        status: 'failed',
        timestamp: Date.now(),
      };
    } else if (type === 'loop_completed') {
      const turns = Number(data.turnCount || 0);
      const tokens = Number(data.totalTokens || 0);
      item = {
        id: `${idBase}-${String(data.agentId || '')}`,
        sessionId,
        title: 'Agent turn completed',
        detail: [turns > 0 ? `${turns} turns` : '', tokens > 0 ? `${tokens} tokens` : ''].filter(Boolean).join(' · ') || undefined,
        status: 'completed',
        timestamp: Date.now(),
      };
    }

    if (!item) return;
    this._floatingBallActivity = [
      item,
      ...this._floatingBallActivity.filter((existing) => existing.id !== item!.id),
    ].slice(0, FLOATING_BALL_ACTIVITY_LIMIT);
  }

  private _recentFloatingBallActivity(): FloatingBallActivityItem[] {
    return this._floatingBallActivity
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, FLOATING_BALL_ACTIVITY_LIMIT);
  }

  private _floatingBallAskUserSnapshot(): FloatingBallWaitingSnapshot {
    const knownAgents = this._conversationVM.getKnownAgents();
    if (knownAgents.length === 0) return { count: 0, first: null };

    const sessions: AskUserSessionMessages[] = knownAgents.map((agent) => {
      const node = this._sessionVM.sessions.getById(agent.sessionId);
      return {
        sessionId: agent.sessionId,
        title: node?.title,
        lastActiveAt: node?.lastActiveAt,
        messages: agent.state.messages.messages,
      };
    });

    return summarizeAskUserWaiting(sessions);
  }

  private _floatingBallGoalSnapshot(
    preferredSessionIds: Array<string | null | undefined>,
    waitingSessionId: string | null,
    waitingCount: number,
  ): FloatingBallGoalPulse | null {
    const checkedRoots = new Set<string>();

    const fromNode = (node: SessionNode | null | undefined): FloatingBallGoalPulse | null => {
      const root = this._floatingBallRootForSession(node);
      if (!root || checkedRoots.has(root.id)) return null;
      checkedRoots.add(root.id);
      const goal = root.metadata?.goal as GoalState | null | undefined;
      if (!goal || goal.status === 'deleted') return null;

      const waitingRoot = waitingSessionId
        ? this._floatingBallRootForSession(this._sessionVM.sessions.getById(waitingSessionId))
        : null;
      const blocked = goal.status === 'active' && waitingCount > 0 && (!waitingRoot || waitingRoot.id === root.id);
      return {
        sessionId: root.id,
        status: blocked ? 'blocked' : goal.status,
        objective: goal.objective || 'Active goal',
        runCount: goal.runCount,
        updatedAt: goal.updatedAt,
        lastRunAt: goal.lastRunAt,
      };
    };

    for (const sessionId of preferredSessionIds) {
      const snapshot = sessionId ? fromNode(this._sessionVM.sessions.getById(sessionId)) : null;
      if (snapshot) return snapshot;
    }

    const recent = [...this._sessionVM.sessions.all]
      .sort((a, b) => new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime());
    for (const session of recent) {
      const snapshot = fromNode(session);
      if (snapshot) return snapshot;
    }
    return null;
  }

  private _floatingBallRootForSession(node: SessionNode | null | undefined): SessionNode | null {
    if (!node) return null;
    let current: SessionNode | null | undefined = node;
    while (current && !this._isFloatingBallRootSession(current)) {
      const parentId: string | null = current.parentId || current.parentSessionId || null;
      current = parentId ? this._sessionVM.sessions.getById(parentId) : null;
    }
    return current || node;
  }

  private _isFloatingBallRootSession(node: SessionNode): boolean {
    return !node.parentId && !node.parentSessionId && (node.level === undefined || node.level === 0);
  }

  private _currentFloatingBallGoalSnapshot(): FloatingBallGoalPulse | null {
    const active = this._sessionVM.activeSession;
    const waitingSnapshot = combineFloatingBallWaiting(
      ToolConfirmationQueue.getInstance().snapshot,
      this._floatingBallAskUserSnapshot(),
    );
    return this._floatingBallGoalSnapshot(
      [waitingSnapshot.first?.sessionId || null, active?.id || null, ...this._conversationVM.getStreamingSessionIds()],
      waitingSnapshot.first?.sessionId || null,
      waitingSnapshot.count,
    );
  }

  private async _handleFloatingBallCommand(payload: { action?: string; data?: unknown }): Promise<void> {
    const action = payload?.action || '';
    const data = (payload?.data || {}) as {
      sessionId?: string;
      question?: string;
      text?: string;
      kind?: string;
      status?: FloatingBallGoalStatus;
      toolCallId?: string;
      approved?: boolean;
    };

    switch (action) {
      case 'open-current':
      case 'open-waiting': {
        this.navigateTo('sessions');
        const target = data.sessionId || this._sessionVM.activeSessionId;
        if (target) this._sessionVM.selectSession(target);
        break;
      }
      case 'open-goal': {
        this.navigateTo('sessions');
        const goal = data.sessionId
          ? this._floatingBallGoalSnapshot([data.sessionId], null, 0)
          : this._currentFloatingBallGoalSnapshot();
        const target = goal?.sessionId || data.sessionId || this._sessionVM.activeSessionId;
        if (target) this._sessionVM.selectSession(target);
        break;
      }
      case 'goal-toggle': {
        const goal = data.sessionId
          ? this._floatingBallGoalSnapshot([data.sessionId], null, 0)
          : this._currentFloatingBallGoalSnapshot();
        const target = goal?.sessionId || data.sessionId || null;
        if (!target) {
          this._pushFloatingBallNotice('info', 'No active goal');
          break;
        }
        if (target !== this._sessionVM.activeSessionId) this._sessionVM.selectSession(target);
        const status = goal?.status || data.status;
        if (status === 'paused') {
          this._conversationVM.setGoal('resume');
          this._pushFloatingBallNotice('success', 'Goal resumed');
        } else if (status === 'active' || status === 'blocked') {
          this._conversationVM.setGoal('pause');
          this._pushFloatingBallNotice('success', 'Goal paused');
        } else {
          this._pushFloatingBallNotice('info', 'Goal is not active');
        }
        break;
      }
      case 'waiting-resolve': {
        const approved = data.approved === true;
        const ok = ToolConfirmationQueue.getInstance().respondToFirst(approved, data.toolCallId);
        if (ok) {
          this._pushFloatingBallNotice('success', approved ? 'Approved waiting item' : 'Rejected waiting item');
        } else {
          this._pushFloatingBallNotice('info', 'Open AnoClaw to review this item');
          this.navigateTo('sessions');
          const target = data.sessionId || this._sessionVM.activeSessionId;
          if (target) this._sessionVM.selectSession(target);
        }
        break;
      }
      case 'continue-current': {
        const sessionId = await this._sendFloatingBallPrompt(
          '继续当前任务，先用一句话说明你接下来会做什么，然后直接推进。',
          data.sessionId || null,
        );
        if (sessionId) this._pushFloatingBallNotice('success', `Continuing ${this._floatingBallSessionTitle(sessionId)}`);
        break;
      }
      case 'stop-current': {
        const target = data.sessionId || this._sessionVM.activeSessionId;
        if (target) {
          await this._conversationVM.getAgent(target).stopGeneration();
          this._pushFloatingBallNotice('success', `Stopped ${this._floatingBallSessionTitle(target)}`);
        } else {
          this._pushFloatingBallNotice('info', 'No active session to stop');
        }
        break;
      }
      case 'quick-ask': {
        const question = (data.question || '').trim();
        if (question) {
          const sessionId = await this._sendFloatingBallPrompt(question, data.sessionId || null);
          if (sessionId) this._pushFloatingBallNotice('success', `Sent to ${this._floatingBallSessionTitle(sessionId)}`);
        }
        break;
      }
      case 'text-action': {
        const prompt = this._buildTextActionPrompt(data.kind || 'ask', data.text || '', data.question || '');
        if (prompt) {
          const sessionId = await this._sendFloatingBallPrompt(prompt, data.sessionId || null);
          if (sessionId) this._pushFloatingBallNotice('success', `Text sent to ${this._floatingBallSessionTitle(sessionId)}`);
        }
        break;
      }
    }
    this._scheduleFloatingBallStateUpdate();
  }

  private _buildTextActionPrompt(kind: string, text: string, question: string): string {
    const selected = text.trim();
    if (!selected) return question.trim();
    const block = `\n\n---\n${selected}\n---`;
    switch (kind) {
      case 'translate':
        return `请把下面这段选中文本翻译成中文。保留专有名词、代码、路径和格式，只输出清晰自然的译文。${block}`;
      case 'polish':
        return `请润色下面这段选中文本。保持原意，改得更清晰、更专业；如果原文是中文就润色中文，如果是英文就润色英文。${block}`;
      case 'summarize':
        return `请总结下面这段选中文本，给出要点和下一步建议。${block}`;
      case 'ask':
      default:
        return question.trim()
          ? `${question.trim()}\n\n请基于下面这段选中文本回答：${block}`
          : `请解释下面这段选中文本，并指出它对当前任务可能有什么用。${block}`;
    }
  }

  private _pushFloatingBallNotice(kind: FloatingBallNoticeKind, text: string): void {
    const api = (window as any).electronAPI;
    if (!api?.floatingBallUpdateState) return;
    api.floatingBallUpdateState({
      helperNotice: {
        kind,
        text: text.trim().slice(0, 140),
        timestamp: Date.now(),
      },
    });
  }

  private _floatingBallSessionTitle(sessionId: string): string {
    return (this._sessionVM.sessions.getById(sessionId)?.title || 'session').slice(0, 48);
  }

  private async _sendFloatingBallPrompt(prompt: string, preferredSessionId?: string | null): Promise<string | null> {
    const content = prompt.trim();
    if (!content) return null;
    const sessionId = await this._ensureFloatingBallSession(preferredSessionId);
    if (!sessionId) return null;
    await this._sessionVM.ensureRunnableAgentForSession(sessionId);
    if (!this._sseClient.connected) throw new Error('WebSocket is not connected. Please wait for reconnection or refresh the page.');
    this.navigateTo('sessions');
    this._sessionVM.selectSession(sessionId);
    const agent = this._conversationVM.getAgent(sessionId);
    await agent.sendMessage(content, this._conversationVM.permissionMode, this._conversationVM.effortMode, []);
    return sessionId;
  }

  private async _ensureFloatingBallSession(preferredSessionId?: string | null): Promise<string | null> {
    if (preferredSessionId && this._sessionVM.sessions.getById(preferredSessionId)) return preferredSessionId;
    if (this._sessionVM.activeSessionId) return this._sessionVM.activeSessionId;
    const recent = [...this._sessionVM.sessions.all]
      .sort((a, b) => new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime());
    if (recent[0]?.id) {
      this._sessionVM.selectSession(recent[0].id);
      return recent[0].id;
    }
    const created = await this._sessionVM.createSession('Quick Ask', undefined);
    return created?.id || null;
  }

  /** Send a quality score rating via WebSocket. */
  sendQualityScore(data: {
    messageId: string;
    sessionId: string;
    agentId: string;
    turnNumber: number;
    score: number;
    comment: string;
  }): void {
    this._sseClient.send({
      type: 'quality_score',
      ...data,
    });
  }
}

  // Bootstrap
document.addEventListener('DOMContentLoaded', async () => {
  await App.getInstance().init();
});

export { App };
