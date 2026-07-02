// ClientLogger — browser-side structured logger (Pino-like API)
// Categories: ui, ws, vm, api, app, render
// Levels: debug, info, warn, error
// Features: ring buffer (500 entries), localStorage persistence, console output

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogCategory = 'ui' | 'ws' | 'vm' | 'api' | 'app' | 'render';

interface LogEntry {
  ts: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const RING_SIZE = 500;
const LS_KEY = 'anoclaw_client_logs';

export class ClientLogger {
  private static _instance: ClientLogger;
  private _buffer: LogEntry[] = [];
  private _enabledCategories: Set<LogCategory> = new Set(['ui', 'ws', 'vm', 'api', 'app', 'render']);
  private _minLevel: LogLevel = 'debug';

  static getInstance(): ClientLogger {
    if (!ClientLogger._instance) {
      ClientLogger._instance = new ClientLogger();
    }
    return ClientLogger._instance;
  }

  private constructor() {
    // Restore from localStorage
    this._loadFromStorage();
  }

  // ── Public: category-scoped logger ──

  logger(category: LogCategory) {
    return {
      debug: (msg: string, data?: Record<string, unknown>) => this._log(category, 'debug', msg, data),
      info: (msg: string, data?: Record<string, unknown>) => this._log(category, 'info', msg, data),
      warn: (msg: string, data?: Record<string, unknown>) => this._log(category, 'warn', msg, data),
      error: (msg: string, data?: Record<string, unknown>) => this._log(category, 'error', msg, data),
    };
  }

  // ── Convenience static accessors ──

  static ui = ClientLogger.getInstance().logger('ui');
  static ws = ClientLogger.getInstance().logger('ws');
  static vm = ClientLogger.getInstance().logger('vm');
  static api = ClientLogger.getInstance().logger('api');
  static app = ClientLogger.getInstance().logger('app');
  static render = ClientLogger.getInstance().logger('render');

  // ── Configuration ──

  setMinLevel(level: LogLevel): void {
    this._minLevel = level;
  }

  enableCategory(cat: LogCategory): void {
    this._enabledCategories.add(cat);
  }

  disableCategory(cat: LogCategory): void {
    this._enabledCategories.delete(cat);
  }

  // ── Query ──

  entries(): ReadonlyArray<LogEntry> {
    return this._buffer;
  }

  recent(n: number): LogEntry[] {
    return this._buffer.slice(-n);
  }

  clear(): void {
    this._buffer = [];
    this._saveToStorage();
  }

  // ── Private ──

  private _levelRank(l: LogLevel): number {
    return { debug: 0, info: 1, warn: 2, error: 3 }[l];
  }

  private _log(category: LogCategory, level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // Filter
    if (!this._enabledCategories.has(category)) return;
    if (this._levelRank(level) < this._levelRank(this._minLevel)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      category,
      level,
      message,
      data,
    };

    // Ring buffer
    this._buffer.push(entry);
    if (this._buffer.length > RING_SIZE) {
      this._buffer = this._buffer.slice(-RING_SIZE);
    }

    // Console output
    const prefix = `[${category}]`;
    const color = { debug: '#888', info: '#4af', warn: '#fa0', error: '#f44' }[level];
    if (data && Object.keys(data).length > 0) {
      console.log(
        `%c${prefix} %c${message}`,
        `color:${color};font-weight:bold`,
        'color:inherit',
        data,
      );
    } else {
      console.log(
        `%c${prefix} %c${message}`,
        `color:${color};font-weight:bold`,
        'color:inherit',
      );
    }

    // Persist to localStorage (throttled — only every 5s)
    this._debouncedSave();
  }

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  private _debouncedSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveToStorage();
      this._saveTimer = null;
    }, 5000);
  }

  private _saveToStorage(): void {
    try {
      const recent = this._buffer.slice(-200);
      localStorage.setItem(LS_KEY, JSON.stringify(recent));
    } catch {
      // localStorage may be full or unavailable
    }
  }

  private _loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        this._buffer = JSON.parse(raw) as LogEntry[];
      }
    } catch {
      // ignore parse errors
    }
  }
}

// Export convenience logger instances
export const logger = {
  ui: ClientLogger.ui,
  ws: ClientLogger.ws,
  vm: ClientLogger.vm,
  api: ClientLogger.api,
  app: ClientLogger.app,
  render: ClientLogger.render,
};
