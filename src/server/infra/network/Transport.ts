/**
 * Transport — abstract message transport for agent stream events.
 * Inspired by Hermes agent's Transport ABC.
 */
export interface Transport {
  /** Send a structured event to a session's client. Returns false if not connected. */
  send(sessionId: string, event: Record<string, unknown>): boolean;

  /** Broadcast to all connected clients. */
  broadcast(event: Record<string, unknown>): void;

  /** True if at least one client is connected (or if sessionId given, connected for that session). */
  isConnected(sessionId?: string): boolean;

  /** Active connection identifiers (for monitoring). */
  activeSessions(): string[];

  /** Graceful shutdown. */
  shutdown(): Promise<void>;

  /** Lifecycle event hooks. */
  on(event: 'clientConnected' | 'clientDisconnected', handler: () => void): void;

  /** Clear buffered events for a session (e.g. on reconnection). */
  clearEventBuffer?(sessionId: string): void;
}
