import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { SessionManager } from '../SessionManager.js';
import { SessionStore } from '../SessionStore.js';
import { recoverRestartCheckpoint } from '../RestartCheckpointRecovery.js';
import { JsonlStore } from '../../../infra/storage/JsonlStore.js';
import { MessageRole, type JsonlEvent, type Message } from '../../../../shared/types/session.js';
import { messageToJsonlEvents } from '../../../../shared/serialization/jsonl-converters.js';

describe('session persistence cold-start recovery', () => {
  let tempRoot = '';
  let sessionsRoot = '';

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-session-recovery-'));
    sessionsRoot = path.join(tempRoot, 'sessions');
    resetSessionSingletons();
  });

  afterEach(async () => {
    resetSessionSingletons();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('restores the tree, messages and event head and continues one UUID chain', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const workspace = path.join(tempRoot, 'workspace');
    const main = await manager.createMainSession('agent-main', 'Main', workspace);
    const child = await manager.createSubSession(main.id, 'agent-child', 'Child');
    const grandchild = await manager.createSubSession(child.id, 'agent-grandchild', 'Grandchild');

    const userMessage = makeMessage(main.id, 'user-1', MessageRole.User, 'hello');
    const assistantMessage: Message = {
      ...makeMessage(main.id, 'assistant-1', MessageRole.Assistant, 'done'),
      thinking: 'reasoning',
      toolCalls: [{ id: 'tool-1', toolName: 'Read', params: { file_path: 'README.md' } }],
      toolResults: [{
        toolCallId: 'tool-1',
        success: true,
        content: 'ok',
        tokensUsed: 1,
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        wasTruncated: false,
      }],
    };
    await manager.appendMessage(main.id, userMessage);
    await manager.appendMessage(main.id, assistantMessage);
    const originalHead = manager.session(main.id)?.lastEventUuid;

    resetSessionSingletons();
    const recovered = SessionManager.getInstance();
    await recovered.initialize(sessionsRoot);

    expect(recovered.session(child.id)?.parentSessionId).toBe(main.id);
    expect(recovered.session(grandchild.id)?.level).toBe(2);
    expect(recovered.session(main.id)?.subSessionIds).toContain(child.id);
    const history = await recovered.getHistory(main.id);
    expect(history.filter((message) => message.id === `sub-created-${child.id}`)).toHaveLength(1);
    expect(history.some((message) => message.id === 'user-1' && message.content === 'hello')).toBe(true);
    expect(history.some((message) => message.id === 'assistant-1' && message.thinking === 'reasoning')).toBe(true);
    expect(recovered.session(main.id)?.lastEventUuid).toBe(originalHead);

    await recovered.appendMessage(
      main.id,
      makeMessage(main.id, 'user-2', MessageRole.User, 'after restart'),
    );
    const events = await SessionStore.getInstance().loadHistory(main.id) as JsonlEvent[];
    for (let index = 1; index < events.length; index++) {
      const current = events[index] as Record<string, unknown>;
      const previous = events[index - 1] as Record<string, unknown>;
      expect(current.parentUuid).toBe(previous.uuid);
    }
    const persistedMeta = JSON.parse(
      await fsp.readFile(path.join(sessionsRoot, main.id, 'meta.json'), 'utf-8'),
    ) as { messageCount: number; eventCount: number; headEventUuid: string };
    expect(persistedMeta.messageCount).toBe((await recovered.getHistory(main.id)).length);
    expect(persistedMeta.eventCount).toBe(events.length);
    expect(persistedMeta.headEventUuid).toBe((events.at(-1) as Record<string, unknown>).uuid);

    const realDataPath = path.resolve(process.cwd(), 'data', 'sessions', main.id);
    expect(existsSync(realDataPath)).toBe(false);
  });

  it('quarantines incomplete metadata instead of exposing a partial Session', async () => {
    const badId = 'partial-session';
    const badDir = path.join(sessionsRoot, badId);
    await fsp.mkdir(badDir, { recursive: true });
    await fsp.writeFile(
      path.join(badDir, 'meta.json'),
      JSON.stringify({
        sessionId: badId,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        messageCount: 3,
      }),
      'utf-8',
    );

    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);

    expect(manager.session(badId)).toBeUndefined();
    expect(existsSync(badDir)).toBe(false);
    const audit = await fsp.readFile(
      path.join(sessionsRoot, '_quarantine', 'audit.jsonl'),
      'utf-8',
    );
    expect(audit).toContain('"reason":"invalid_or_incomplete_meta"');
  });

  it('truncates only an incomplete final JSONL tail during recovery', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession('agent-main', 'Tail', path.join(tempRoot, 'workspace'));
    await manager.appendMessage(
      session.id,
      makeMessage(session.id, 'user-tail', MessageRole.User, 'committed'),
    );
    const shardPath = path.join(sessionsRoot, session.id, 'shard_000000.jsonl');
    await fsp.appendFile(shardPath, '{"type":"assistant","uuid":"torn', 'utf-8');

    resetSessionSingletons();
    const recovered = SessionManager.getInstance();
    await recovered.initialize(sessionsRoot);

    const history = await recovered.getHistory(session.id);
    expect(history.some((message) => message.id === 'user-tail')).toBe(true);
    const repaired = await fsp.readFile(shardPath, 'utf-8');
    expect(repaired.endsWith('\n')).toBe(true);
    expect(repaired).not.toContain('"uuid":"torn');
  });

  it('switches compacted history through an active generation', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession('agent-main', 'Rewrite', path.join(tempRoot, 'workspace'));
    await manager.appendMessage(
      session.id,
      makeMessage(session.id, 'before', MessageRole.User, 'old history'),
    );

    await manager.rewriteHistory(session.id, [
      makeMessage(session.id, 'after', MessageRole.User, 'new history'),
    ]);

    const manifest = JSON.parse(await fsp.readFile(
      path.join(sessionsRoot, session.id, 'active-history.json'),
      'utf-8',
    )) as { generation: string };
    expect(manifest.generation).toMatch(/^gen-/);
    const history = await manager.getHistory(session.id);
    expect(history.map((message) => message.id)).toEqual(['after']);
  });

  it('rolls back a whole append batch when interrupted before its commit marker', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession(
      'agent-main',
      'Append transaction',
      path.join(tempRoot, 'workspace'),
    );
    const store = SessionStore.getInstance();
    const before = await store.loadHistory(session.id) as JsonlEvent[];
    const jsonl = JsonlStore.getInstance() as unknown as {
      atomicWriteText(filePath: string, content: string, keepBackup: boolean): Promise<void>;
    };
    const originalAtomicWrite = jsonl.atomicWriteText.bind(jsonl);
    let interrupted = false;
    jsonl.atomicWriteText = async (filePath, content, keepBackup) => {
      if (
        !interrupted
        && path.basename(filePath) === 'append-transaction.json'
        && JSON.parse(content).state === 'committed'
      ) {
        interrupted = true;
        throw new Error('simulated append interruption');
      }
      await originalAtomicWrite(filePath, content, keepBackup);
    };

    const batch = [
      ...messageToJsonlEvents(
        makeMessage(session.id, 'batch-1', MessageRole.Assistant, 'first'),
        session.lastEventUuid || '00000000-0000-0000-0000-000000000000',
      ),
      ...messageToJsonlEvents(
        makeMessage(session.id, 'batch-2', MessageRole.Assistant, 'second'),
        'temporary-parent',
      ),
    ];
    await expect(store.appendEvents(session.id, batch, {
      messageDelta: 2,
      sync: true,
    })).rejects.toThrow('simulated append interruption');
    jsonl.atomicWriteText = originalAtomicWrite;

    resetSessionSingletons();
    const recovered = SessionManager.getInstance();
    await recovered.initialize(sessionsRoot);
    const events = await SessionStore.getInstance().loadHistory(session.id) as JsonlEvent[];
    expect(events).toHaveLength(before.length);
    expect(events.some((event) => (
      event.type === 'assistant'
      && 'message' in event
      && event.message.id === 'batch-1'
    ))).toBe(false);
  });

  it('keeps the old history when generation switching is interrupted', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession(
      'agent-main',
      'Generation interruption',
      path.join(tempRoot, 'workspace'),
    );
    await manager.appendMessage(
      session.id,
      makeMessage(session.id, 'old-generation', MessageRole.User, 'old'),
    );

    const jsonl = JsonlStore.getInstance() as unknown as {
      atomicWriteText(filePath: string, content: string, keepBackup: boolean): Promise<void>;
    };
    const originalAtomicWrite = jsonl.atomicWriteText.bind(jsonl);
    jsonl.atomicWriteText = async (filePath, content, keepBackup) => {
      if (path.basename(filePath) === 'active-history.json') {
        throw new Error('simulated generation switch interruption');
      }
      await originalAtomicWrite(filePath, content, keepBackup);
    };
    await expect(manager.rewriteHistory(session.id, [
      makeMessage(session.id, 'new-generation', MessageRole.User, 'new'),
    ])).rejects.toThrow('simulated generation switch interruption');
    jsonl.atomicWriteText = originalAtomicWrite;

    resetSessionSingletons();
    const recovered = SessionManager.getInstance();
    await recovered.initialize(sessionsRoot);
    const history = await recovered.getHistory(session.id);
    expect(history.map((message) => message.id)).toContain('old-generation');
    expect(history.map((message) => message.id)).not.toContain('new-generation');
  });

  it('repairs stale metadata from a committed event tail after metadata replacement fails', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession(
      'agent-main',
      'Metadata repair',
      path.join(tempRoot, 'workspace'),
    );
    const jsonl = JsonlStore.getInstance() as unknown as {
      atomicReplace(filePath: string, content: Buffer): Promise<void>;
    };
    const originalAtomicReplace = jsonl.atomicReplace.bind(jsonl);
    const metaPath = path.join(sessionsRoot, session.id, 'meta.json');
    let failed = false;
    jsonl.atomicReplace = async (filePath, content) => {
      if (!failed && path.resolve(filePath) === path.resolve(metaPath)) {
        failed = true;
        throw new Error('simulated metadata replacement failure');
      }
      await originalAtomicReplace(filePath, content);
    };

    const event = messageToJsonlEvents(
      makeMessage(session.id, 'committed-with-stale-meta', MessageRole.User, 'durable'),
      session.lastEventUuid || '00000000-0000-0000-0000-000000000000',
    );
    await SessionStore.getInstance().appendEvents(session.id, event, {
      messageDelta: 1,
      sync: true,
    });
    jsonl.atomicReplace = originalAtomicReplace;

    resetSessionSingletons();
    const recovered = SessionManager.getInstance();
    await recovered.initialize(sessionsRoot);
    const history = await recovered.getHistory(session.id);
    const meta = await JsonlStore.getInstance().getMeta(session.id);
    expect(history.map((message) => message.id)).toContain('committed-with-stale-meta');
    expect(meta.eventCount).toBe((await SessionStore.getInstance().loadHistory(session.id)).length);
    expect(meta.headEventUuid).toBe(recovered.session(session.id)?.lastEventUuid);
  });

  it('deduplicates restart checkpoint recovery after a crash before checkpoint deletion', async () => {
    const manager = SessionManager.getInstance();
    await manager.initialize(sessionsRoot);
    const session = await manager.createMainSession(
      'agent-main',
      'Restart',
      path.join(tempRoot, 'workspace'),
    );
    const checkpointPath = path.join(tempRoot, 'restart-checkpoint.json');
    const now = Date.now();
    await fsp.writeFile(checkpointPath, JSON.stringify({
      restartId: 'restart-once',
      sessionId: session.id,
      resumeMessage: 'continue exactly once',
      timestamp: now,
    }), 'utf-8');

    const first = await recoverRestartCheckpoint(checkpointPath, {
      sessionManager: manager,
      now: now + 100,
      deleteAfterSuccess: false,
    });
    const second = await recoverRestartCheckpoint(checkpointPath, {
      sessionManager: manager,
      now: now + 200,
      deleteAfterSuccess: false,
    });

    expect(first.status).toBe('recovered');
    expect(second.status).toBe('deduplicated');
    const history = await manager.getHistory(session.id);
    expect(history.filter((message) => message.id === 'restart-restart-once')).toHaveLength(1);
  });
});

function makeMessage(
  sessionId: string,
  id: string,
  role: Message['role'],
  content: string,
): Message {
  return {
    id,
    sessionId,
    role,
    content,
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };
}

function resetSessionSingletons(): void {
  SessionManager.resetInstance();
  SessionStore.resetInstance();
  JsonlStore.resetInstance();
}
