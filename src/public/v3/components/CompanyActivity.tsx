import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import type { Agent, CompanyEventEnvelope, Task, WorkEventEnvelope } from '../model.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Icon } from './Icon.js';

type ActivityEvent = CompanyEventEnvelope | WorkEventEnvelope;

export function CompanyActivity() {
  const { t, formatTime } = useI18n();
  const { snapshot, selectedWork, selectedWorkDetail } = useShellState();
  const events: ActivityEvent[] = [
    ...snapshot.companyEvents,
    ...(selectedWorkDetail?.events ?? []),
  ]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, 3);
  const completedTasks = (selectedWorkDetail?.tasks ?? [])
    .filter((task) => task.status === 'completed')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 1);

  return (
    <aside class="company-activity" aria-labelledby="company-activity-title">
      <section class="activity-section">
        <h2 id="company-activity-title">{t('activity.title')}</h2>
        {events.length === 0
          ? <p class="quiet-copy activity-empty">{t('activity.empty')}</p>
          : (
            <ol class="activity-list">
              {events.map((entry) => {
                const agent = actorAgent(entry, snapshot.agents);
                const summary = summarizeEvent(entry, t);
                return (
                  <li key={entry.eventId} class="activity-item">
                    <AgentAvatar agent={agent} size="small" />
                    <div>
                      <time dateTime={entry.occurredAt}>{formatTime(entry.occurredAt)}</time>
                      <p>
                        <strong>{agent?.name ?? t('work.mainAgent')}</strong>
                        {' '}
                        {summary.action}
                      </p>
                      <span>{summary.subject}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
      </section>

      <section class="activity-section activity-section--deliverables">
        <h2>{t('activity.deliverables')}</h2>
        {completedTasks.length === 0
          ? <p class="quiet-copy activity-empty">{t('activity.noDeliverables')}</p>
          : completedTasks.map((task) => <Deliverable key={task.id} task={task} />)}
        {selectedWork && (
          <button
            class="text-button"
            type="button"
            onClick={() => {
              location.hash = 'work';
              document.querySelector<HTMLElement>('.work-page')?.focus();
            }}
          >
            {t('activity.viewWork')}
            <Icon name="collapse" size={13} />
          </button>
        )}
      </section>
    </aside>
  );
}

function Deliverable({ task }: { task: Task }) {
  const { formatTime } = useI18n();
  return (
    <article class="deliverable">
      <span class="deliverable-icon"><Icon name="document" size={20} /></span>
      <div>
        <time dateTime={task.updatedAt}>{formatTime(task.updatedAt)}</time>
        <strong>{task.title}</strong>
        {task.description && <p>{task.description}</p>}
      </div>
    </article>
  );
}

function actorAgent(event: ActivityEvent, agents: Agent[]): Agent | undefined {
  const actorId = event.actor?.id;
  if (actorId) {
    const exact = agents.find((agent) => agent.id === actorId);
    if (exact) return exact;
  }
  const payload = event.event as unknown as Record<string, Record<string, unknown> | string>;
  for (const value of Object.values(payload)) {
    if (!value || typeof value !== 'object') continue;
    const agentId = typeof value.agentId === 'string'
      ? value.agentId
      : typeof value.ownerAgentId === 'string'
        ? value.ownerAgentId
        : typeof value.assignedAgentId === 'string'
          ? value.assignedAgentId
          : undefined;
    if (agentId) return agents.find((agent) => agent.id === agentId);
  }
  return agents.find((agent) => /^main\s*agent$/i.test(agent.name));
}

function summarizeEvent(
  envelope: ActivityEvent,
  t: ReturnType<typeof useI18n>['t'],
): { action: string; subject: string } {
  const event = envelope.event as unknown as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';
  const subject = Object.entries(event)
    .filter(([key, value]) => key !== 'type' && value && typeof value === 'object')
    .map(([, value]) => value as { title?: unknown; name?: unknown; summary?: unknown })
    .map((value) => [value.title, value.name, value.summary].find((entry) => typeof entry === 'string'))
    .find(Boolean);
  const action = type.endsWith('.created')
    ? t('activity.created')
    : type.endsWith('.reported')
      ? t('activity.reported')
      : type.endsWith('.completed')
        ? t('activity.completed')
        : type.startsWith('run.') || type.startsWith('session.')
          ? t('activity.started')
          : t('activity.updated');
  return {
    action,
    subject: typeof subject === 'string' ? subject : t('activity.item'),
  };
}
