// Extension — interface for pluggable subsystems
// Each major subsystem implements this interface so it can be
// auto-discovered, started, stopped, and toggled via configuration.

export interface Extension {
  /** Unique identifier (kebab-case). Used for feature flags: extensions.disabled: ['id'] */
  readonly id: string;
  /** Human-readable name for logs and diagnostics */
  readonly name: string;
  /** IDs of other extensions that must be started before this one */
  readonly dependencies: string[];
  /** Called at startup. Must be idempotent. */
  start(): Promise<void>;
  /** Called at shutdown. Must be idempotent. */
  stop(): Promise<void>;
  /** Whether this extension is currently running */
  isRunning(): boolean;
}
