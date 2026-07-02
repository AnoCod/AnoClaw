// Verify: no double-persist + SessionAgent per-session independent pipeline architecture.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname || __dirname, '..', '..', '..', '..', '..');

describe('No double-persist', () => {
  it('SendMessageHandler no longer calls persister.bufferDelta directly', () => {
    const src = readFileSync(join(ROOT, 'src/server/infra/network/handlers/SendMessageHandler.ts'), 'utf-8');
    expect(src).not.toMatch(/persister\.bufferDelta/);
  });

  it('StreamConsumer still calls persister.bufferDelta — single correct path', () => {
    const src = readFileSync(join(ROOT, 'src/server/infra/stream/StreamConsumer.ts'), 'utf-8');
    expect(src).toMatch(/_persister\.bufferDelta\('text'/);
    expect(src).toMatch(/_persister\.bufferDelta\('think'/);
  });
});

describe('SessionAgent — per-session independent pipeline', () => {
  it('SessionAgent exists with onServerEvent, sendMessage, loadHistory, stopGeneration', () => {
    const src = readFileSync(join(ROOT, 'src/public/ts/viewmodel/SessionAgent.ts'), 'utf-8');
    expect(src).toMatch(/class SessionAgent extends EventEmitter/);
    expect(src).toMatch(/onServerEvent\(/);
    expect(src).toMatch(/async sendMessage\(/);
    expect(src).toMatch(/async loadHistory\(/);
    expect(src).toMatch(/async stopGeneration\(/);
    expect(src).toMatch(/agent\.state\.messages/);
    expect(src).toMatch(/agent\.emit\(/);
  });

  it('ConversationViewModel is AgentRegistry — no handleWsEvent, no _silentEmit', () => {
    const src = readFileSync(join(ROOT, 'src/public/ts/viewmodel/ConversationViewModel.ts'), 'utf-8');
    expect(src).toMatch(/_agents.*Map/);
    expect(src).toMatch(/getAgent\(/);
    expect(src).not.toMatch(/_silentEmit/);
    expect(src).not.toMatch(/handleWsEvent/);
    expect(src).not.toMatch(/_requireActive/);
    expect(src).not.toMatch(/const prev = this\._activeSessionId/);
  });

  it('ChatHandlers routes directly to SessionAgent.onServerEvent', () => {
    const src = readFileSync(join(ROOT, 'src/public/ts/handlers/ChatHandlers.ts'), 'utf-8');
    expect(src).toMatch(/getAgent\(/);
    expect(src).toMatch(/agent\.onServerEvent\(/);
  });

  it('SessionsPage has _bindToAgent / _unbindFromAgent', () => {
    const src = readFileSync(join(ROOT, 'src/public/ts/components/pages/SessionsPage.ts'), 'utf-8');
    expect(src).toMatch(/_bindToAgent\(/);
    expect(src).toMatch(/_unbindFromAgent\(/);
    expect(src).toMatch(/agent\.state/);
    expect(src).not.toMatch(/convVM\.messages/);
    expect(src).not.toMatch(/convVM\.isStreaming/);
  });
});
