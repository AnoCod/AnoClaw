import { useState } from 'preact/hooks';
import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import type { Agent, Team } from '../model.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Icon } from './Icon.js';

export function CompanyFloor() {
  const { t } = useI18n();
  const { snapshot } = useShellState();
  const [collapsed, setCollapsed] = useState(false);
  const activeAgents = snapshot.agents.filter((agent) => agent.status !== 'archived');
  const assignedIds = new Set(snapshot.memberships.map((membership) => membership.agentId));
  const groups = snapshot.teams
    .filter((team) => !team.archivedAt && team.id !== snapshot.company?.rootTeamId)
    .map((team) => ({
      team,
      agents: snapshot.memberships
        .filter((membership) => membership.teamId === team.id && !membership.removedAt)
        .map((membership) => activeAgents.find((agent) => agent.id === membership.agentId))
        .filter((agent): agent is Agent => Boolean(agent)),
    }))
    .filter((group) => group.agents.length > 0);
  const unassigned = activeAgents.filter((agent) => !assignedIds.has(agent.id));

  if (unassigned.length > 0) {
    groups.unshift({
      team: {
        id: 'unassigned',
        companyId: snapshot.company?.id ?? '',
        name: t('floor.unassigned'),
        createdAt: '',
        updatedAt: '',
      },
      agents: unassigned,
    });
  }

  return (
    <section class={`company-floor ${collapsed ? 'is-collapsed' : ''}`} aria-labelledby="company-floor-title">
      <header>
        <div>
          <img src="/assets/v3/brand-mark.png" alt="" width="17" height="17" />
          <h2 id="company-floor-title">{t('floor.title')}</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-expanded={!collapsed}
          aria-controls="company-floor-groups"
          aria-label={collapsed ? t('floor.expand') : t('floor.collapse')}
          title={collapsed ? t('floor.expand') : t('floor.collapse')}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name="collapse" size={15} />
        </button>
      </header>

      {!collapsed && (
        <div id="company-floor-groups" class="floor-groups">
          {groups.length === 0 && <p class="quiet-copy">{t('floor.empty')}</p>}
          {groups.map((group, index) => (
            <div class="floor-group-wrap" key={group.team.id}>
              <TeamGroup team={group.team} agents={group.agents} />
              {index < groups.length - 1 && (
                <FloorConnector
                  label={index === 0
                    ? t('floor.insightHandoff')
                    : t('floor.strategyHandoff')}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FloorConnector({ label }: { label: string }) {
  return (
    <span class="floor-connector" aria-label={label}>
      <small>{label}</small>
      <span>
        <i />
        <b />
        <Icon name="collapse" size={12} />
      </span>
    </span>
  );
}

function TeamGroup({ team, agents }: { team: Team; agents: Agent[] }) {
  return (
    <article class="floor-team">
      <h3>{team.name}</h3>
      <div class="floor-agents">
        {agents.slice(0, 5).map((agent) => (
          <div class="floor-agent" key={agent.id}>
            <AgentAvatar agent={agent} size="medium" />
            <strong>{agent.name}</strong>
            {agent.description && <span>{agent.description}</span>}
          </div>
        ))}
      </div>
    </article>
  );
}
