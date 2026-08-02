import * as fsp from 'node:fs/promises';
import { SessionManager } from './SessionManager.js';

export interface RestartCheckpoint {
  restartId: string;
  sessionId: string;
  resumeMessage: string;
  timestamp: number;
}

export interface RestartCheckpointRecoveryResult {
  status: 'missing' | 'recovered' | 'deduplicated' | 'retained_failed';
  sessionId?: string;
  restartId?: string;
  ageMs?: number;
  failedPath?: string;
  reason?: string;
}

export async function recoverRestartCheckpoint(
  checkpointPath: string,
  options: {
    sessionManager?: SessionManager;
    now?: number;
    maxAgeMs?: number;
    deleteAfterSuccess?: boolean;
  } = {},
): Promise<RestartCheckpointRecoveryResult> {
  const manager = options.sessionManager || SessionManager.getInstance();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;

  let raw: string;
  try {
    raw = await fsp.readFile(checkpointPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw error;
  }

  let checkpoint: RestartCheckpoint | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<RestartCheckpoint>;
    if (
      typeof parsed.restartId === 'string'
      && parsed.restartId
      && typeof parsed.sessionId === 'string'
      && parsed.sessionId
      && typeof parsed.resumeMessage === 'string'
      && parsed.resumeMessage
      && typeof parsed.timestamp === 'number'
    ) {
      checkpoint = parsed as RestartCheckpoint;
    }
  } catch {
    checkpoint = null;
  }

  const ageMs = checkpoint ? now - checkpoint.timestamp : undefined;
  const target = checkpoint ? manager.session(checkpoint.sessionId) : undefined;
  if (
    !checkpoint
    || ageMs === undefined
    || ageMs < 0
    || ageMs >= maxAgeMs
    || !target
  ) {
    const failedPath = `${checkpointPath}.failed-${now}.json`;
    await fsp.rename(checkpointPath, failedPath);
    return {
      status: 'retained_failed',
      sessionId: checkpoint?.sessionId,
      restartId: checkpoint?.restartId,
      ageMs,
      failedPath,
      reason: !checkpoint
        ? 'invalid_checkpoint'
        : !target
          ? 'session_not_recovered'
          : 'checkpoint_expired',
    };
  }

  const messageId = `restart-${checkpoint.restartId}`;
  const history = await manager.getHistory(target.id);
  const duplicate = history.some((message) => message.id === messageId);
  if (!duplicate) {
    await manager.appendMessage(target.id, {
      id: messageId,
      sessionId: target.id,
      role: 'system',
      content: `[Server restarted]\n\nBefore restart I was working on:\n${checkpoint.resumeMessage}\n\nNow continuing.`,
      tokenCount: 0,
      compressed: false,
      timestamp: new Date(now).toISOString(),
      agentId: 'system',
    }, { notify: false });
  }
  manager.setActiveSession(manager.getRootSession(target.id).id);
  if (options.deleteAfterSuccess !== false) {
    await fsp.rm(checkpointPath, { force: true });
  }
  return {
    status: duplicate ? 'deduplicated' : 'recovered',
    sessionId: target.id,
    restartId: checkpoint.restartId,
    ageMs,
  };
}
