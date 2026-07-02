/**
 * Core-level logger — console-first with optional LogManager bridge.
 *
 * Every core file imports this instead of LogManager directly.
 * Debug/info go to console (visible during development).
 * Warn/error also persist to LogManager for file audit.
 *
 * Usage: import { log } from '../logger.js'; log.info(...)
 * Scoped:  import { createLogger } from '../logger.js';
 *          const log = createLogger('anochat.agent');
 */

// Lazy import — LogManager is infra, only loaded when first needed
let _logManager: { logger: (cat: string) => { debug: Function; info: Function; warn: Function; error: Function } } | null = null;

function getLogManager() {
  if (_logManager) return _logManager;
  try {
    // Dynamic import to avoid hard infra dependency at module load time
    const { LogManager } = require('../../infra/logging/LogManager.js') as { LogManager: { getInstance: () => { logger: (cat: string) => { debug: Function; info: Function; warn: Function; error: Function } } } };
    _logManager = LogManager.getInstance();
  } catch {
    // LogManager unavailable — console-only mode
  }
  return _logManager;
}

export interface CoreLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): CoreLogger;
}

function formatMsg(category: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString().slice(11, 23);
  const metaStr = meta ? ' ' + Object.entries(meta).filter(([,v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 50) : v}`).join(' ') : '';
  return `[${ts}] ${category} ${msg}${metaStr}`;
}

export function createLogger(category: string): CoreLogger {
  return {
    debug(msg: string, meta?: Record<string, unknown>) {
      console.debug(formatMsg(category, msg, meta));
    },
    info(msg: string, meta?: Record<string, unknown>) {
      console.info(formatMsg(category, msg, meta));
      // Also file-persist info+ for audit
      getLogManager()?.logger(category).info(msg, meta);
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      console.warn(formatMsg(category, msg, meta));
      getLogManager()?.logger(category).warn(msg, meta);
    },
    error(msg: string, meta?: Record<string, unknown>) {
      console.error(formatMsg(category, msg, meta));
      getLogManager()?.logger(category).error(msg, meta);
    },
    child(scope: string): CoreLogger {
      return createLogger(`${category}.${scope}`);
    },
  };
}

/** Default unscoped logger */
export const log = createLogger('anochat');
