/**
 * ILogger — logger interface used by all core domain code.
 *
 * Core code depends on this interface, not on LogManager directly.
 * LogManager (in infra/logging) implements this interface.
 * Removes the core → infra coupling for logging.
 *
 * @module ILogger
 */

export interface ILogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  /** Get a scoped child logger. Defaults to returning self if unsupported. */
  child?(scope: string): ILogger;
}
