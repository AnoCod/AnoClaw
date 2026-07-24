// LogManager — Pino-based structured logging with rotating files
// 9 log categories, rotating file output, API call audit trail, and key sanitization

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { createStream, RotatingFileStream } from 'rotating-file-stream';
import { LogEvents } from '../../../shared/types/events.js';
import type { ILogger } from '../../core/interfaces/ILogger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: string;
  cat: string;
  msg: string;
  sid?: string;       // session ID
  aid?: string;       // agent ID
  [key: string]: unknown;
}

interface ConsoleLogger {
  trace: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  fatal: (msg: string, data?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 9 canonical log categories */
export const LOG_CATEGORIES = [
  'anochat.core',
  'anochat.agent',
  'anochat.api',
  'anochat.tools',
  'anochat.mcp',
  'anochat.gateway',
  'anochat.llm',
  'anochat.ui',
  'anochat.system',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

const MAX_RECENT_ENTRIES = 1000;    // ring buffer per category
const MAX_SEARCH_RESULTS = 500;
const API_CALLS_FILE = 'api_calls.jsonl';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 10;

const LEVEL_PRIORITY: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

// ---------------------------------------------------------------------------
// LogSanitizer
// ---------------------------------------------------------------------------

export class LogSanitizer {
  // Match common API key patterns:
  //   - Anthropic: sk-ant-...
  //   - OpenAI:   sk-...
  //   - Generic:  key=..., api_key=..., "apiKey": "..."
  //   - Bearer token in Authorization headers
  private static apiKeyPatterns: RegExp[] = [
    /sk-ant-(?:api\d{2}|admin)-[A-Za-z0-9\-_]{20,}/g,
    /sk-[A-Za-z0-9\-_]{30,}/g,
    /(?:api[_-]?key[=:]\s*["']?)([A-Za-z0-9\-_]{20,})/gi,
    /(?:bearer\s+)([A-Za-z0-9\-_]{20,})/gi,
    /"apiKey"\s*:\s*"[^"]{10,}"/gi,
  ];

  /** Replace API keys and tokens with [REDACTED] */
  static sanitize(text: string): string {
    let result = text;
    for (const pattern of this.apiKeyPatterns) {
      result = result.replace(pattern, (match, capture) => {
        // For patterns with capture groups, redact only the secret part
        if (capture && typeof capture === 'string' && capture.length > 10) {
          const idx = match.indexOf(capture);
          return match.slice(0, idx) + '[REDACTED]';
        }
        return '[REDACTED]';
      });
    }
    return result;
  }

  /** Sanitize an object's string values recursively (shallow clone) */
  static sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...obj };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string') {
        result[key] = this.sanitize(value);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.sanitizeObject(value as Record<string, unknown>);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// LogManager
// ---------------------------------------------------------------------------

export class LogManager extends EventEmitter {
  private static _instance: LogManager;

  private _logDir: string = 'logs';
  private _initialized = false;
  private _minLevel: string = 'trace';

  /** Per-category ring buffers */
  private _recent: Map<string, LogEntry[]> = new Map();

  /** Console-based loggers */
  private _loggers: Map<string, ConsoleLogger> = new Map();

  /** Pino rotating-file loggers for per-category file output */
  private _pinoLoggers: Map<string, pino.Logger> = new Map();

  /** Write stream for api_calls.jsonl (rotating) */
  private _apiCallsStream: RotatingFileStream | null = null;

  // Separate ring buffer for all entries (for cross-category searching)
  private _allEntries: LogEntry[] = [];

  private constructor() {
    super();
    // Set higher limit for listeners since many subsystems will subscribe
    this.setMaxListeners(50);
  }

  static getInstance(): LogManager {
    if (!LogManager._instance) {
      LogManager._instance = new LogManager();
    }
    return LogManager._instance;
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  initialize(logDir: string): void {
    if (this._initialized) return;

    this._logDir = logDir;

    // Ensure log directory exists
    const absDir = path.resolve(process.cwd(), logDir);
    try {
      fs.mkdirSync(absDir, { recursive: true });
    } catch {
      // If we can't create the log dir, we'll log to console only
    }

    // Create console-based loggers + pino rotating-file loggers for each category
    for (const cat of LOG_CATEGORIES) {
      this._recent.set(cat, []);
      this._loggers.set(cat, this.createConsoleLogger(cat));

      // Create pino rotating-file logger for this category
      this.initPinoLogger(cat);
    }

    this._initialized = true;
    this.info('anochat.system', 'LogManager initialized', { logDir });
  }

  /**
   * Set the minimum log level. Entries below this level are dropped.
   * Levels (low→high): trace, debug, info, warn, error, fatal
   */
  setMinLevel(level: string): void {
    if (LEVEL_PRIORITY[level] !== undefined) {
      this._minLevel = level;
    }
  }

  // -----------------------------------------------------------------------
  // Logger access
  // -----------------------------------------------------------------------

  /**
   * Get a logger for a specific category.
   * Returns a ConsoleLogger that writes to console + pino rotating file.
   */
  logger(category: string): ConsoleLogger & ILogger {
    if (!this._loggers.has(category)) {
      this._recent.set(category, []);
      this._loggers.set(category, this.createConsoleLogger(category));
      this.initPinoLogger(category);
    }
    return this._loggers.get(category)! as ConsoleLogger & ILogger;
  }

  // -----------------------------------------------------------------------
  // Convenience methods (used by LogManager itself and other subsystems)
  // -----------------------------------------------------------------------

  private createConsoleLogger(category: string): ConsoleLogger & ILogger {
    const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
      this.recordEntry(category, level, msg, data);
    };

    return {
      trace: (msg, data) => emit('trace', msg, data),
      debug: (msg, data) => emit('debug', msg, data),
      info: (msg, data) => emit('info', msg, data),
      warn: (msg, data) => emit('warn', msg, data),
      error: (msg, data) => emit('error', msg, data),
      fatal: (msg, data) => emit('fatal', msg, data),
      child: (scope: string) => LogManager.getInstance().logger(`${category}.${scope}`),
    };
  }

  /**
   * Initialize a pino rotating-file logger for the given category.
   * Creates a rotating file stream and a pino logger writing to it.
   */
  private initPinoLogger(cat: string): void {
    if (this._pinoLoggers.has(cat)) return;
    const shortName = cat.replace(/^anochat\./, '');
    const absDir = path.resolve(process.cwd(), this._logDir);
    try {
      const fileStream = createStream(`anochat.${shortName}.log`, {
        size: '10M',
        maxFiles: MAX_FILES,
        path: absDir,
      });
      this._pinoLoggers.set(
        cat,
        pino({ level: 'trace' }, fileStream),
      );
    } catch {
      // If pino file logger fails, fall back to console-only
    }
  }

  // -----------------------------------------------------------------------
  // Core logging (called by the ConsoleLogger wrappers)
  // -----------------------------------------------------------------------

  private recordEntry(cat: string, level: string, msg: string, data?: Record<string, unknown>): void {
    // Skip if level is below configured minimum
    if ((LEVEL_PRIORITY[level] ?? 0) < (LEVEL_PRIORITY[this._minLevel] ?? 0)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      cat,
      msg,
      ...data,
    };

    // Sanitize before storing
    // sanitizeObject returns Record<string,unknown>; we know the shape is LogEntry
    const sanitized = LogSanitizer.sanitizeObject(entry) as unknown as LogEntry;

    // Write to console (fallback) — pino file output happens below
    const logFn =
      level === 'error' || level === 'fatal' ? console.error
      : level === 'warn' ? console.warn
      : level === 'debug' || level === 'trace' ? console.debug
      : console.log;

    const meta = sanitized.sid ? ` [sid=${sanitized.sid}]` : '';
    const agentMeta = sanitized.aid ? ` [aid=${sanitized.aid}]` : '';
    logFn(`[${sanitized.ts}] ${level.toUpperCase()} ${cat}${meta}${agentMeta} ${sanitized.msg}`);

    // Write to pino rotating-file logger (structured JSON output)
    const pinoLogger = this._pinoLoggers.get(cat);
    if (pinoLogger) {
      const pinoData: Record<string, unknown> = { cat };
      if (sanitized.sid) pinoData.sid = sanitized.sid;
      if (sanitized.aid) pinoData.aid = sanitized.aid;
      // Forward any extra structured fields from the caller
      if (data) {
        for (const [k, v] of Object.entries(data)) {
          if (!['msg', 'sid', 'aid'].includes(k)) {
            pinoData[k] = v;
          }
        }
      }
      pinoLogger[level as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'](pinoData, sanitized.msg);
    }

    // Ring buffer for recent entries
    const recent = this._recent.get(cat);
    if (recent) {
      recent.push(sanitized);
      if (recent.length > MAX_RECENT_ENTRIES) {
        recent.shift();
      }
    }

    // Global ring buffer for search
    this._allEntries.push(sanitized);
    if (this._allEntries.length > MAX_RECENT_ENTRIES * 2) {
      this._allEntries.shift();
    }

    // Emit for subscribers (UI, monitoring, etc.)
    this.emit(LogEvents.NewLogEntry, sanitized);

    // If this is an API call log, also write to api_calls.jsonl
    if (cat === 'anochat.api' && (level === 'info' || level === 'error')) {
      this.writeApiCall(sanitized);
    }
  }

  // -----------------------------------------------------------------------
  // Direct logging (used by LogManager itself)
  // -----------------------------------------------------------------------

  private info(cat: string, msg: string, data?: Record<string, unknown>): void {
    this.recordEntry(cat, 'info', msg, data);
  }

  // -----------------------------------------------------------------------
  // Recent entries & search
  // -----------------------------------------------------------------------

  /** Get the N most recent entries for a category */
  recentEntries(category: string, count = 50): LogEntry[] {
    const recent = this._recent.get(category);
    if (!recent) return [];
    return recent.slice(-count).reverse();
  }

  /** Search across all categories by keyword */
  search(keyword: string, limit = 100): LogEntry[] {
    const lower = keyword.toLowerCase();
    const results: LogEntry[] = [];

    // Search backwards (most recent first)
    for (let i = this._allEntries.length - 1; i >= 0 && results.length < limit; i--) {
      const entry = this._allEntries[i];
      if (
        entry.msg.toLowerCase().includes(lower) ||
        entry.cat.toLowerCase().includes(lower) ||
        entry.level.toLowerCase().includes(lower) ||
        (entry.sid && entry.sid.toLowerCase().includes(lower)) ||
        (entry.aid && entry.aid.toLowerCase().includes(lower))
      ) {
        results.push(entry);
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // API call audit trail
  // -----------------------------------------------------------------------

  private writeApiCall(entry: LogEntry): void {
    try {
      // Lazy-initialize rotating stream
      if (!this._apiCallsStream) {
        const absDir = path.resolve(process.cwd(), this._logDir);
        fs.mkdirSync(absDir, { recursive: true });
        this._apiCallsStream = createStream(API_CALLS_FILE, {
          size: `${MAX_FILE_BYTES / (1024 * 1024)}M`,
          maxFiles: MAX_FILES,
          path: absDir,
        });
      }

      const line = JSON.stringify(entry) + '\n';
      this._apiCallsStream.write(line);
    } catch {
      // If API call logging fails, emit to stderr but don't crash
      console.error('[LogManager] Failed to write API call log entry');
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Flush and close streams (call during shutdown) */
  async shutdown(): Promise<void> {
    if (this._apiCallsStream) {
      const stream = this._apiCallsStream;
      this._apiCallsStream = null;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          stream.off('finish', onFinish);
          reject(error);
        };
        const onFinish = (): void => {
          stream.off('error', onError);
          resolve();
        };
        stream.once('error', onError);
        stream.once('finish', onFinish);
        stream.end();
      });
    }

    // Flush pino rotating-file loggers
    await Promise.all([...this._pinoLoggers.values()].map((logger) => (
      new Promise<void>((resolve, reject) => {
        logger.flush((error?: Error) => error ? reject(error) : resolve());
      })
    )));
    this._pinoLoggers.clear();

    this._initialized = false;
  }
}
