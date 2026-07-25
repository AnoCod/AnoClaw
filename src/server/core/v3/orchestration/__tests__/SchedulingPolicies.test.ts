import { describe, expect, it } from 'vitest';
import type { Task } from '../../../../../shared/types/v3/index.js';
import {
  COMPANY_LOOP_LIMIT,
  ConcurrencyPolicy,
  MISSION_LOOP_LIMIT,
  type LoopReservation,
} from '../ConcurrencyPolicy.js';
import { FairTaskQueue } from '../FairTaskQueue.js';

describe('ConcurrencyPolicy', () => {
  const policy = new ConcurrencyPolicy();

  it('caps a company at four active loops', () => {
    const active = Array.from({ length: COMPANY_LOOP_LIMIT }, (_, index): LoopReservation => ({
      companyId: 'company-1',
      missionId: `mission-${index}`,
      agentId: `agent-${index}`,
      accessMode: 'write',
    }));

    expect(policy.canStart({
      companyId: 'company-1',
      missionId: 'new-mission',
      agentId: 'new-agent',
      accessMode: 'read',
    }, active)).toEqual({
      allowed: false,
      code: 'company_limit_reached',
      limit: 4,
      active: 4,
    });
  });

  it('caps a mission at four active loops', () => {
    const active = Array.from({ length: MISSION_LOOP_LIMIT }, (_, index): LoopReservation => ({
      companyId: 'company-1',
      missionId: 'mission-1',
      agentId: `agent-${index}`,
      accessMode: 'read',
    }));

    expect(policy.canStart({
      companyId: 'company-1',
      missionId: 'mission-1',
      agentId: 'new-agent',
      accessMode: 'read',
    }, active)).toEqual({
      allowed: false,
      code: 'mission_limit_reached',
      limit: 4,
      active: 4,
    });
  });

  it('allows two reads per agent but makes a write exclusive', () => {
    const oneRead: LoopReservation[] = [{
      companyId: 'company-1',
      missionId: 'mission-1',
      agentId: 'agent-1',
      accessMode: 'read',
    }];
    expect(policy.canStart({
      companyId: 'company-1',
      missionId: 'mission-2',
      agentId: 'agent-1',
      accessMode: 'read',
    }, oneRead)).toEqual({ allowed: true });
    expect(policy.canStart({
      companyId: 'company-1',
      missionId: 'mission-2',
      agentId: 'agent-1',
      accessMode: 'write',
    }, oneRead)).toMatchObject({
      allowed: false,
      code: 'agent_write_exclusive',
    });

    const twoReads: LoopReservation[] = [
      ...oneRead,
      {
        companyId: 'company-1',
        missionId: 'mission-2',
        agentId: 'agent-1',
        accessMode: 'read',
      },
    ];
    expect(policy.canStart({
      companyId: 'company-1',
      missionId: 'mission-3',
      agentId: 'agent-1',
      accessMode: 'read',
    }, twoReads)).toMatchObject({
      allowed: false,
      code: 'agent_read_limit_reached',
    });
  });
});

describe('FairTaskQueue', () => {
  it('combines priority with unbounded aging to prevent starvation', () => {
    const queue = new FairTaskQueue(15 * 60_000);
    const now = Date.parse('2026-01-01T01:00:00.000Z');
    const oldLow = task('old-low', 'low', '2026-01-01T00:00:00.000Z');
    const newCritical = task('new-critical', 'critical', '2026-01-01T01:00:00.000Z');

    expect(queue.score(oldLow, now)).toBe(4);
    expect(queue.score(newCritical, now)).toBe(3);
    expect(queue.order([newCritical, oldLow], now).map((value) => value.id))
      .toEqual(['old-low', 'new-critical']);
  });

  it('orders equal effective priorities by oldest enqueue time and then id', () => {
    const queue = new FairTaskQueue();
    const now = Date.parse('2026-01-01T01:00:00.000Z');
    const sameTimeB = task('b', 'normal', '2026-01-01T00:45:00.000Z');
    const sameTimeA = task('a', 'normal', '2026-01-01T00:45:00.000Z');

    expect(queue.order([sameTimeB, sameTimeA], now).map((value) => value.id))
      .toEqual(['a', 'b']);
  });

  it('does not grant invalid timestamps an artificial aging boost', () => {
    const queue = new FairTaskQueue();
    const now = Date.parse('2026-01-01T01:00:00.000Z');
    const malformed = task('malformed', 'low', 'not-a-date');
    const critical = task('critical', 'critical', '2026-01-01T01:00:00.000Z');

    expect(queue.order([malformed, critical], now).map((value) => value.id))
      .toEqual(['critical', 'malformed']);
  });
});

function task(id: string, priority: Task['priority'], createdAt: string): Task {
  return {
    id,
    workId: 'work-1',
    missionId: 'mission-1',
    title: id,
    acceptanceCriteria: ['Done'],
    status: 'ready',
    priority,
    dependsOnTaskIds: [],
    readOnly: false,
    writeScope: [],
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}
