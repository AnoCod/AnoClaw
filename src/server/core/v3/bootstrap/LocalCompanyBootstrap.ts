import * as path from 'node:path';
import type { CompanyLocale, CompanyProjection } from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { AppendOnlyEventStore } from '../store/AppendOnlyEventStore.js';
import { CompanyRepository } from '../store/CompanyRepository.js';

export const LOCAL_COMPANY_ID = 'local-company';
export const LOCAL_ROOT_TEAM_ID = 'root-team';
export const LOCAL_MAIN_AGENT_ID = 'main-agent';
export const LOCAL_MAIN_MEMBERSHIP_ID = 'main-agent-root-membership';

export interface LocalCompanyBootstrapOptions {
  expectedRevision?: number;
  defaultLocale?: CompanyLocale;
  companyName?: string;
  clock?: () => string;
}

/**
 * Establish the one local v3 Company authority after the first explicit
 * Company creation request.
 *
 * All four authority records share one event/revision so readers never observe
 * a Company without its root Team and MainAgent. Existing v3 or v2 data is
 * never modified, migrated, or removed.
 */
export async function bootstrapLocalCompany(
  rootDir = path.resolve('data', 'v3'),
  options: LocalCompanyBootstrapOptions = {},
): Promise<CompanyProjection> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const repository = new CompanyRepository(rootDir, { clock });
  const projection = await repository.getProjection();
  if (projection.company) {
    throw new V3DomainError('ALREADY_EXISTS', 'This AnoClaw install already has a company');
  }

  const workIds = await new AppendOnlyEventStore(rootDir).listWorkIds();
  if (projection.revision !== 0 || workIds.length > 0) {
    throw new V3DomainError(
      'CORRUPT_EVENT_STREAM',
      'Cannot bootstrap v3 Company because data/v3 is not empty',
      { revision: projection.revision, workIds },
    );
  }

  return repository.bootstrapCompany(
    {
      id: LOCAL_COMPANY_ID,
      name: options.companyName ?? 'AnoClaw',
      mainAgentId: LOCAL_MAIN_AGENT_ID,
      mainAgentName: 'MainAgent',
      rootTeamId: LOCAL_ROOT_TEAM_ID,
      rootTeamName: 'Company',
      membershipId: LOCAL_MAIN_MEMBERSHIP_ID,
      defaultLocale: options.defaultLocale ?? 'zh-CN',
    },
    {
      expectedRevision: options.expectedRevision ?? 0,
      eventId: 'bootstrap-local-company',
      occurredAt: clock(),
      actor: { type: 'system', id: 'v3-bootstrap' },
    },
  );
}
