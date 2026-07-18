import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WsServer } from '../WsServer.js';

type BufferedEntry = { event: Record<string, unknown>; ts: number; seq: number };

function internals(server: WsServer): {
  _conn: null;
  _seqCounter: number;
  _eventBuffers: Map<string, BufferedEntry[]>;
} {
  return server as unknown as {
    _conn: null;
    _seqCounter: number;
    _eventBuffers: Map<string, BufferedEntry[]>;
  };
}

describe('WsServer disconnected buffering', () => {
  const server = WsServer.getInstance();

  beforeEach(() => {
    const state = internals(server);
    state._conn = null;
    state._seqCounter = 0;
    state._eventBuffers.clear();
  });

  it('coalesces adjacent text deltas while disconnected', () => {
    server.send('session-1', { type: 'text', content: 'hello ' });
    server.send('session-1', { type: 'text', content: 'world' });

    const buffer = internals(server)._eventBuffers.get('session-1');
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]?.event.content).toBe('hello world');
  });

  it('retains a terminal event even when the buffer is full', () => {
    for (let i = 0; i < 300; i++) {
      server.send('session-1', { type: 'tool_call', id: `tool-${i}`, name: 'Read' });
    }
    server.send('session-1', { type: 'done' });

    const buffer = internals(server)._eventBuffers.get('session-1') || [];
    expect(buffer).toHaveLength(300);
    expect(buffer.some((entry) => entry.event.type === 'done')).toBe(true);
  });

  it('does not clear reconnect buffers merely because a turn completed', () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const source = readFileSync(
      join(root, 'src/server/infra/network/handlers/SendMessageHandler.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/clearEventBuffer\?\.\(effectiveSessionId\)/);
  });
});
