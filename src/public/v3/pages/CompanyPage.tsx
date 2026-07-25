import { useState } from 'preact/hooks';
import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import {
  pickWorkspaceFolder,
  WorkspacePickerUnavailableError,
  workspaceNameFromPath,
} from '../app/workspacePicker.js';
import { AgentAvatar } from '../components/AgentAvatar.js';
import { Icon } from '../components/Icon.js';

export function CompanyPage() {
  const { t } = useI18n();
  const { snapshot, createWorkspace, busyAction } = useShellState();
  const [pickerError, setPickerError] = useState(false);
  const teams = snapshot.teams.filter((team) => !team.archivedAt);
  const agents = snapshot.agents.filter((agent) => agent.status !== 'archived');
  const workspaces = snapshot.workspaces.filter((workspace) => !workspace.archivedAt);
  const addWorkspace = async () => {
    setPickerError(false);
    try {
      const rootPath = await pickWorkspaceFolder(
        t('workspace.pickerTitle'),
        t('workspace.pickerConfirm'),
      );
      if (!rootPath) return;
      const exists = workspaces.some(
        (workspace) => normalizeWorkspacePath(workspace.rootPath)
          === normalizeWorkspacePath(rootPath),
      );
      if (!exists) await createWorkspace(workspaceNameFromPath(rootPath), rootPath);
    } catch (error) {
      if (error instanceof WorkspacePickerUnavailableError) setPickerError(true);
    }
  };

  return (
    <main class="secondary-page" tabIndex={-1}>
      <header class="secondary-page-header">
        <span class="eyebrow">{snapshot.company?.name ?? t('company.title')}</span>
        <h1>{t('company.title')}</h1>
        <p>{t('company.subtitle')}</p>
      </header>

      <div class="metric-row" aria-label={t('company.title')}>
        <Metric icon="company" value={teams.length} label={t('company.teams')} />
        <Metric icon="active" value={agents.length} label={t('company.agents')} />
        <Metric icon="folder" value={workspaces.length} label={t('company.workspaces')} />
      </div>

      <section class="company-grid-section">
        <h2>{t('company.teams')}</h2>
        {teams.length === 0 && <p class="quiet-copy">{t('company.noTeams')}</p>}
        <div class="company-card-grid">
          {teams.map((team) => {
            const members = snapshot.memberships
              .filter((membership) => membership.teamId === team.id && !membership.removedAt)
              .map((membership) => agents.find((agent) => agent.id === membership.agentId))
              .filter(Boolean);
            return (
              <article class="company-card" key={team.id}>
                <header>
                  <div>
                    <h3>{team.name}</h3>
                    {team.description && <p>{team.description}</p>}
                  </div>
                  <span>{members.length}</span>
                </header>
                <div class="avatar-stack">
                  {members.slice(0, 5).map((agent) => agent && (
                    <AgentAvatar key={agent.id} agent={agent} size="small" />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section class="company-grid-section">
        <h2>{t('company.agents')}</h2>
        {agents.length === 0 && <p class="quiet-copy">{t('company.noAgents')}</p>}
        <div class="agent-directory">
          {agents.map((agent) => (
            <article class="agent-directory-item" key={agent.id}>
              <AgentAvatar agent={agent} size="medium" />
              <div>
                <h3>{agent.name}</h3>
                <p>{agent.description ?? t('common.noDescription')}</p>
              </div>
              <span class={`status-pill status-pill--${agent.status}`}>
                {agent.status === 'active' ? t('company.active') : t('company.paused')}
              </span>
            </article>
          ))}
        </div>
      </section>

      <section class="company-grid-section">
        <div class="section-heading">
          <div>
            <h2>{t('company.workspaces')}</h2>
            <p>{t('company.workspacesHelp')}</p>
          </div>
          <button
            class="secondary-button workspace-add-button"
            type="button"
            disabled={busyAction === 'create-workspace'}
            onClick={() => void addWorkspace()}
          >
            <Icon name="folder" size={15} />
            {busyAction === 'create-workspace' ? t('workspace.adding') : t('workspace.add')}
          </button>
        </div>
        {workspaces.length === 0 && <p class="quiet-copy">{t('company.noWorkspaces')}</p>}
        {pickerError && (
          <p class="field-message field-message--error">{t('workspace.pickerUnavailable')}</p>
        )}
        <div class="workspace-list">
          {workspaces.map((workspace) => (
            <article key={workspace.id}>
              <Icon name="folder" size={18} />
              <div>
                <strong>{workspace.name}</strong>
                <span>{workspace.rootPath}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function normalizeWorkspacePath(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLocaleLowerCase();
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: 'company' | 'active' | 'folder';
  value: number;
  label: string;
}) {
  return (
    <article class="metric">
      <Icon name={icon} size={18} />
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}
