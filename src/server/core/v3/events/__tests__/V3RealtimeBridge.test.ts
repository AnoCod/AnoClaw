import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WsServer } from '../../../../infra/network/WsServer.js';
import { CompanyRepository, INSTALL_COMPANY_SCOPE } from '../../store/CompanyRepository.js';
import { AppendOnlyEventStore } from '../../store/AppendOnlyEventStore.js';
import { V3EventHub } from '../V3EventHub.js';
import { V3RealtimeBridge } from '../V3RealtimeBridge.js';

const NOW = '2026-07-25T09:00:00.000Z';

describe('V3RealtimeBridge', () => {
  let rootDir = '';
  let repository: CompanyRepository;
  let store: AppendOnlyEventStore;
  let ws: FakeWsServer;
  let bridge: V3RealtimeBridge;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-realtime-'));
    V3EventHub.resetInstance();
    repository = new CompanyRepository(rootDir, { clock: () => NOW });
    store = new AppendOnlyEventStore(rootDir);
    ws = new FakeWsServer();
    bridge = new V3RealtimeBridge(
      ws as unknown as WsServer,
      store,
      V3EventHub.getInstance(),
    );
  });

  afterEach(async () => {
    bridge.stop();
    V3EventHub.resetInstance();
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('replays durable revisions to the subscribing socket, then broadcasts live appends', async () => {
    await repository.bootstrapCompany(
      {
        id: 'company-1',
        name: 'AnoClaw',
        rootTeamId: 'team-root',
        mainAgentId: 'agent-main',
        membershipId: 'membership-main',
        defaultLocale: 'zh-CN',
      },
      { expectedRevision: 0, eventId: 'bootstrap', occurredAt: NOW },
    );
    bridge.start();
    const replies: Array<Record<string, unknown>> = [];

    ws.emit('message', 'primary', {
      type: 'v3_subscribe',
      companyAfterRevision: 0,
      works: [],
    }, (payload: Record<string, unknown>) => {
      replies.push(payload);
      return true;
    });
    await waitFor(() => replies.some((message) => message.type === 'v3_subscribed'));

    expect(replies).toContainEqual(expect.objectContaining({
      type: 'v3_event',
      scopeType: 'company',
      scopeId: INSTALL_COMPANY_SCOPE,
      revision: 1,
      replayed: true,
    }));

    await repository.updateCompany(
      { description: 'Persistent AI company' },
      { expectedRevision: 1, eventId: 'company-update', occurredAt: NOW },
    );
    expect(ws.broadcasts).toContainEqual(expect.objectContaining({
      type: 'v3_event',
      scopeType: 'company',
      revision: 2,
      replayed: false,
    }));
  });

  it('requires a fresh REST snapshot when a client revision is ahead', async () => {
    bridge.start();
    const replies: Array<Record<string, unknown>> = [];
    ws.emit('message', 'primary', {
      type: 'v3_subscribe',
      companyAfterRevision: 99,
      works: [],
    }, (payload: Record<string, unknown>) => {
      replies.push(payload);
      return true;
    });
    await waitFor(() => replies.some((message) => message.type === 'v3_subscribed'));

    expect(replies).toContainEqual(expect.objectContaining({
      type: 'v3_snapshot_required',
      scopeType: 'company',
      currentRevision: 0,
      reason: 'client_revision_ahead',
    }));
  });
});

class FakeWsServer extends EventEmitter {
  readonly broadcasts: Array<Record<string, unknown>> = [];

  broadcast(data: Record<string, unknown>): void {
    this.broadcasts.push(data);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for realtime reply');
}
