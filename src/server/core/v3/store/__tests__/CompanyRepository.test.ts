import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompanyRepository } from '../CompanyRepository.js';

describe('CompanyRepository', () => {
  let tempRoot = '';
  let repository: CompanyRepository;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-company-'));
    repository = new CompanyRepository(tempRoot);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('persists one company with nested teams and independent memberships', async () => {
    const company = await repository.createCompany(
      companyInput(),
      command(0, 'company-created'),
    );
    const agent = await repository.createAgent(
      { id: 'agent-1', name: 'Builder' },
      command(1, 'agent-created'),
    );
    const parent = await repository.createTeam(
      { id: 'team-parent', name: 'Engineering' },
      command(2, 'parent-created'),
    );
    const child = await repository.createTeam(
      { id: 'team-child', name: 'Runtime', parentTeamId: parent.id },
      command(3, 'child-created'),
    );
    const primary = await repository.addMembership(
      {
        id: 'membership-primary',
        teamId: parent.id,
        agentId: agent.id,
        role: 'leader',
        isPrimary: true,
      },
      command(4, 'primary-added'),
    );
    const secondary = await repository.addMembership(
      {
        id: 'membership-secondary',
        teamId: child.id,
        agentId: agent.id,
        role: 'member',
      },
      command(5, 'secondary-added'),
    );

    expect(company.id).toBe('company-1');
    expect(agent.allowedTools).toEqual(['*']);
    expect(child.parentTeamId).toBe(parent.id);
    expect(primary.isPrimary).toBe(true);
    expect(secondary.isPrimary).toBe(false);
    expect((await repository.getProjection()).revision).toBe(6);

    await expect(repository.updateMembership(
      secondary.id,
      { isPrimary: true },
      command(6, 'second-primary'),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.createCompany(
      {
        ...companyInput(),
        id: 'company-2',
        name: 'Forbidden second company',
      },
      command(6, 'second-company'),
    )).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('rejects team cycles and archival that would orphan durable relationships', async () => {
    await repository.createCompany(
      companyInput(),
      command(0, 'company-created'),
    );
    await repository.createAgent(
      { id: 'agent-1', name: 'Builder' },
      command(1, 'agent-created'),
    );
    await repository.createTeam(
      { id: 'team-a', name: 'A' },
      command(2, 'team-a-created'),
    );
    await repository.createTeam(
      { id: 'team-b', name: 'B', parentTeamId: 'team-a' },
      command(3, 'team-b-created'),
    );
    await repository.addMembership(
      {
        id: 'membership-1',
        teamId: 'team-b',
        agentId: 'agent-1',
        role: 'member',
      },
      command(4, 'membership-created'),
    );

    await expect(repository.updateTeam(
      'team-a',
      { parentTeamId: 'team-b' },
      command(5, 'cycle'),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.archiveTeam('team-b', command(5, 'archive-team')))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.archiveAgent('agent-1', command(5, 'archive-agent')))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rebuilds a disposable checkpoint from the append-only source of truth', async () => {
    await repository.createCompany(
      companyInput(),
      command(0, 'company-created'),
    );
    await repository.createAgent(
      { id: 'agent-1', name: 'Builder' },
      command(1, 'agent-created'),
    );
    const projectionPath = path.join(tempRoot, 'company', 'projection.json');
    await fsp.writeFile(projectionPath, '{"broken":', 'utf-8');

    const recovered = new CompanyRepository(tempRoot);
    const projection = await recovered.getProjection();

    expect(projection.company?.id).toBe('company-1');
    expect(projection.agents['agent-1']?.name).toBe('Builder');
    expect(projection.revision).toBe(2);
    const checkpoint = JSON.parse(await fsp.readFile(projectionPath, 'utf-8')) as {
      revision: number;
      lastEventId: string;
    };
    expect(checkpoint).toMatchObject({ revision: 2, lastEventId: 'agent-created' });
  });
});

function command(expectedRevision: number, eventId: string) {
  return {
    expectedRevision,
    eventId,
    occurredAt: `2026-01-01T00:00:${String(expectedRevision).padStart(2, '0')}.000Z`,
  };
}

function companyInput() {
  return {
    id: 'company-1',
    name: 'AnoClaw',
    mainAgentId: 'main-agent',
    rootTeamId: 'root-team',
    defaultLocale: 'zh-CN' as const,
  };
}
