import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../SessionStore.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import { defaultConfig } from '../../agent/AgentConfig.js';
import { AgentRole } from '../../../../shared/types/agent.js';

describe('SessionStore agent fallback', () => {
  let tmpDir = '';
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-session-store-'));
    SessionStore.resetInstance();
    AgentRegistry.resetInstance();
    store = SessionStore.getInstance();
    await store.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    AgentRegistry.resetInstance();
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-session-store-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('repairs legacy meta without agentId to the registered MainAgent id', async () => {
    registerAgent('workspace-ceo', AgentRole.MainAgent);
    const sessionId = 'legacy-session';
    const sessionDir = path.join(tmpDir, 'sessions', sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(
      path.join(sessionDir, 'meta.json'),
      JSON.stringify({
        sessionId,
        parentSessionId: null,
        level: 0,
        type: 'Main',
        status: 'Idle',
        title: 'Legacy Session',
        workspace: '',
        createdAt: '2026-07-05T00:00:00.000Z',
        lastActiveAt: '2026-07-05T00:00:00.000Z',
        subSessionIds: [],
        metadata: {},
      }),
      'utf-8',
    );

    const meta = await store.readSessionMeta(sessionId);

    expect(meta?.agentId).toBe('workspace-ceo');
  });
});

function registerAgent(id: string, role: AgentRole): void {
  const config = defaultConfig({
    id,
    name: id,
    role,
    model: 'test-model',
    provider: 'openai-compatible',
    apiUrl: 'https://example.test',
    apiKey: 'test-key',
  });
  AgentRegistry.getInstance().registerAgent(new Agent(config));
}
