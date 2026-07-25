import { useEffect, useState } from 'preact/hooks';
import { V3ApiClient } from '../api/V3ApiClient.js';
import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import {
  pickWorkspaceFolder,
  WorkspacePickerUnavailableError,
  workspaceNameFromPath,
} from '../app/workspacePicker.js';
import type {
  Agent,
  Mission,
  Session,
  Task,
  TranscriptEntry,
  TranscriptMessage,
  VerificationRecord,
  Work,
  Workspace,
} from '../model.js';
import { AgentAvatar } from '../components/AgentAvatar.js';
import { Icon } from '../components/Icon.js';
import { SessionInspector } from '../components/SessionInspector.js';

const transcriptApi = new V3ApiClient();

export function WorkPage() {
  const { t } = useI18n();
  const state = useShellState();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [visibleSessionId, setVisibleSessionId] = useState<string | null>(null);
  const [runTranscript, setRunTranscript] = useState<TranscriptEntry[]>([]);
  const [runTranscriptLoading, setRunTranscriptLoading] = useState(false);

  useEffect(() => {
    setVisibleSessionId(state.selectedWork?.primarySessionId ?? null);
    setRunTranscript([]);
    setInspectorOpen(false);
  }, [state.selectedWork?.id]);

  const primarySessionId = state.selectedWork?.primarySessionId ?? null;
  const effectiveSessionId = visibleSessionId ?? primarySessionId;
  const visibleSession = state.selectedWorkDetail?.sessions.find(
    (session) => session.id === effectiveSessionId,
  ) ?? state.selectedSession;
  const isViewingPrimary = visibleSession?.id === primarySessionId;

  useEffect(() => {
    if (!visibleSession || visibleSession.id === primarySessionId) {
      setRunTranscript([]);
      setRunTranscriptLoading(false);
      return;
    }
    let active = true;
    setRunTranscript([]);
    setRunTranscriptLoading(true);
    void transcriptApi.loadSessionTranscript(visibleSession.id)
      .then((result) => {
        if (active) setRunTranscript(result.data);
      })
      .catch(() => {
        if (active) setRunTranscript([]);
      })
      .finally(() => {
        if (active) setRunTranscriptLoading(false);
      });
    return () => {
      active = false;
    };
  }, [visibleSession?.id, primarySessionId]);

  if (state.loading && !state.snapshot.company) {
    return <main class="work-page centered-page" tabIndex={-1}><LoadingCard /></main>;
  }
  if (!state.snapshot.company) {
    return <main class="work-page centered-page" tabIndex={-1}><CompanyBootstrap /></main>;
  }
  if (!state.selectedWork) {
    return <main class="work-page centered-page" tabIndex={-1}><NewWorkForm /></main>;
  }

  const workspace = state.snapshot.workspaces.find(
    (entry) => entry.id === state.selectedWork?.workspaceId,
  );
  const mainAgent = findMainAgent(
    state.snapshot.agents,
    state.selectedSession?.agentId,
  );
  const visibleAgent = state.snapshot.agents.find(
    (agent) => agent.id === visibleSession?.agentId,
  ) ?? mainAgent;
  const statusKey = statusLabel(state.selectedWork);
  const transcript = isViewingPrimary
    ? state.selectedWorkDetail?.transcript ?? []
    : runTranscript;
  const latestMainAgentReply = [...transcript].reverse().find(
    (entry): entry is TranscriptMessage => (
      entry.kind === 'message' && entry.role === 'assistant'
    ),
  );
  const sessionCount = state.selectedWorkDetail?.sessions.length ?? 0;

  return (
    <main class="work-page" tabIndex={-1}>
      <header class="work-header">
        <div>
          <h1>{state.selectedWork.title}</h1>
          <p class="work-meta">
            <span><Icon name="idle" size={13} />{t('work.workspace')} · {workspace?.name ?? '—'}</span>
            <span class={`work-status work-status--${state.selectedWork.status}`}>
              <Icon name="active" size={9} />
              {t(statusKey)}
            </span>
          </p>
        </div>
        <div class="work-header-actions">
          <button
            class={`secondary-button session-inspector-trigger ${inspectorOpen ? 'is-active' : ''}`}
            type="button"
            aria-expanded={inspectorOpen}
            aria-controls="session-transparency-panel"
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <Icon name="overview" size={14} />
            <span class="session-trigger-label">{t('session.show')}</span>
            {sessionCount > 0 && <span class="session-trigger-count">{sessionCount}</span>}
          </button>
          {['active', 'paused'].includes(state.selectedWork.status) && (
            <button
              class="secondary-button danger-button"
              type="button"
              disabled={state.busyAction === 'toggle-work' || !state.selectedWorkDetail}
              onClick={() => void state.toggleSelectedWork().catch(() => undefined)}
            >
              <Icon name="minimize" size={13} />
              {state.selectedWork.status === 'paused' ? t('work.resume') : t('work.stop')}
            </button>
          )}
        </div>
      </header>

      <section class="work-scroll">
        {inspectorOpen && state.selectedWorkDetail && (
          <div id="session-transparency-panel">
            <SessionInspector
              work={state.selectedWork}
              sessions={state.selectedWorkDetail.sessions}
              tasks={state.selectedWorkDetail.tasks}
              agents={state.snapshot.agents}
              selectedSessionId={effectiveSessionId ?? state.selectedWork.primarySessionId}
              onSelect={setVisibleSessionId}
              onClose={() => setInspectorOpen(false)}
            />
          </div>
        )}

        {visibleSession && !isViewingPrimary && (
          <RunSessionContext
            session={visibleSession}
            task={state.selectedWorkDetail?.tasks.find(
              (task) => task.id === visibleSession.taskId,
            )}
            onReturn={() => setVisibleSessionId(primarySessionId)}
          />
        )}

        <Conversation
          work={state.selectedWork}
          transcript={transcript}
          session={visibleSession}
          agent={visibleAgent}
          loading={state.detailLoading || runTranscriptLoading}
          readOnly={!isViewingPrimary}
        />

        {isViewingPrimary && (
          <>
            <section class="objective-section" aria-labelledby="objective-title">
              <div class="agent-introduction">
                <AgentAvatar agent={mainAgent} size="large" priority />
                <div>
                  <h2>{mainAgent?.name ?? t('work.mainAgent')}</h2>
                  <h3 id="objective-title">
                    {latestMainAgentReply
                      ? firstSentence(latestMainAgentReply.content)
                      : t('work.objective')}
                  </h3>
                  <p>{state.selectedWork.objective}</p>
                </div>
              </div>
            </section>

            <ExecutionSummary
              missions={state.selectedWorkDetail?.missions ?? []}
              tasks={state.selectedWorkDetail?.tasks ?? []}
              verifications={state.selectedWorkDetail?.verifications ?? []}
            />
          </>
        )}

        <Composer viewingRun={!isViewingPrimary} />
      </section>
    </main>
  );
}

function RunSessionContext({
  session,
  task,
  onReturn,
}: {
  session: Session;
  task?: Task;
  onReturn: () => void;
}) {
  const { t } = useI18n();
  return (
    <section class="run-session-context" aria-label={t('session.readOnly')}>
      <div>
        <span>{t('session.readOnly')}</span>
        <strong>{session.actorSnapshot.name}</strong>
        <p>{task?.title ?? t('session.unlinkedRun')}</p>
      </div>
      <button class="text-button" type="button" onClick={onReturn}>
        <Icon name="work" size={14} />
        {t('session.backToMain')}
      </button>
    </section>
  );
}

function Conversation({
  work,
  transcript,
  session,
  agent,
  loading,
  readOnly,
}: {
  work: Work;
  transcript: TranscriptEntry[];
  session: Session | null;
  agent?: Agent;
  loading: boolean;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const visible = (readOnly
    ? transcript
    : transcript.filter(
      (entry): entry is TranscriptMessage => entry.kind === 'message'
        && entry.role === 'user',
    )).slice(-12);

  if (loading && visible.length === 0) {
    return <div class="conversation-skeleton" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (visible.length === 0) {
    return (
      <section class="conversation-empty">
        <span>{readOnly ? session?.actorSnapshot.name : work.title}</span>
        <p>{readOnly ? t('session.noTranscript') : t('work.noMessages')}</p>
      </section>
    );
  }

  return (
    <section
      class={`conversation ${readOnly ? 'conversation--run' : ''}`}
      aria-label={readOnly ? t('session.runConversation') : work.title}
    >
      {visible.map((entry) => {
        if (entry.kind === 'event') {
          return (
            <div key={entry.id} class="transcript-event">
              <Icon name="timer" size={12} />
              <span>{entry.eventType}</span>
            </div>
          );
        }
        return (
          <article
            key={entry.id}
            class={`transcript-message transcript-message--${entry.role}`}
          >
            {entry.role === 'assistant' && <AgentAvatar agent={agent} size="small" />}
            <div>
              {(readOnly || entry.role !== 'user') && (
                <strong>
                  {entry.role === 'assistant'
                    ? agent?.name ?? session?.actorSnapshot.name ?? t('work.mainAgent')
                    : entry.role === 'user'
                      ? t('session.assignment')
                      : entry.role === 'tool'
                        ? entry.toolName ?? t('session.tool')
                        : t('session.system')}
                </strong>
              )}
              <p>{entry.content}</p>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function ExecutionSummary({
  missions,
  tasks,
  verifications,
}: {
  missions: Mission[];
  tasks: Task[];
  verifications: VerificationRecord[];
}) {
  const { t, formatTime } = useI18n();
  const { busyAction, verifyTask } = useShellState();
  const sortedMissions = [...missions].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );

  return (
    <section class="execution-summary" aria-labelledby="execution-summary-title">
      <h2 id="execution-summary-title">{t('work.progress')}</h2>
      {sortedMissions.length === 0
        ? <p class="empty-plan">{t('work.noPlan')}</p>
        : (
          <ol>
            {sortedMissions.map((mission, index) => {
              const missionTasks = tasks.filter((task) => task.missionId === mission.id);
              const completed = missionTasks.filter((task) => task.status === 'completed').length;
              const pendingVerification = verifications.find((verification) => (
                verification.mode === 'user'
                && verification.outcome === 'pending'
                && missionTasks.some((task) => task.id === verification.taskId)
              ));
              const verifyingTask = pendingVerification
                ? missionTasks.find((task) => task.id === pendingVerification.taskId)
                : undefined;
              const criteriaText = mission.acceptanceCriteria.length > 0
                ? mission.acceptanceCriteria
                : verifyingTask?.acceptanceCriteria ?? [mission.objective];
              const verifyBusy = verifyingTask
                ? busyAction === `verify-task:${verifyingTask.id}`
                : false;
              const decide = (
                outcome: 'approved' | 'revision_required',
              ) => {
                if (!verifyingTask) return;
                void verifyTask(
                  verifyingTask.id,
                  outcome,
                  outcome === 'approved'
                    ? t('verification.approvedSummary')
                    : t('verification.revisionSummary'),
                  criteriaText.map((criterion) => ({
                    criterion,
                    passed: outcome === 'approved',
                    evidence: [t('verification.userEvidence')],
                  })),
                ).catch(() => undefined);
              };
              return (
                <li key={mission.id} class={`stage stage--${mission.status}`}>
                  <span class="stage-marker">
                    <Icon
                      name={mission.status === 'completed' ? 'check' : 'idle'}
                      size={12}
                    />
                  </span>
                  <div class="stage-copy">
                    <strong>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      {mission.title}
                    </strong>
                    <small>{mission.objective}</small>
                  </div>
                  <span class="stage-count">
                    {missionTasks.length > 0 ? `${completed}/${missionTasks.length}` : t(stageKey(mission.status))}
                  </span>
                  <time dateTime={mission.updatedAt}>{formatTime(mission.updatedAt)}</time>
                  {pendingVerification && verifyingTask && (
                    <div class="user-verification">
                      <div>
                        <strong>{t('verification.userRequired')}</strong>
                        <small>{verifyingTask.title}</small>
                      </div>
                      <button
                        class="secondary-button"
                        type="button"
                        disabled={verifyBusy}
                        onClick={() => decide('revision_required')}
                      >
                        {t('verification.requestRevision')}
                      </button>
                      <button
                        class="primary-button"
                        type="button"
                        disabled={verifyBusy}
                        onClick={() => decide('approved')}
                      >
                        {t('verification.approve')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}

function Composer({ viewingRun }: { viewingRun: boolean }) {
  const { t } = useI18n();
  const { selectedSession, busyAction, sendMessage } = useShellState();
  const [message, setMessage] = useState('');
  const disabled = !selectedSession || busyAction === 'send-message';

  async function submit(event: Event) {
    event.preventDefault();
    const content = message.trim();
    if (!content || disabled) return;
    setMessage('');
    try {
      await sendMessage(content);
    } catch {
      setMessage(content);
    }
  }

  return (
    <div class={`composer-wrap ${viewingRun ? 'is-viewing-run' : ''}`}>
      {viewingRun && <p><Icon name="work" size={12} />{t('session.composerMainOnly')}</p>}
      <form class="work-composer" onSubmit={submit}>
        <label class="sr-only" for="mainagent-message">{t('work.tellAgent')}</label>
        <textarea
          id="mainagent-message"
          rows={1}
          value={message}
          disabled={!selectedSession}
          placeholder={selectedSession ? t('work.tellAgent') : t('work.noSession')}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          class="send-button"
          type="submit"
          disabled={disabled || !message.trim()}
          aria-label={t('work.send')}
          title={t('work.send')}
        >
          <Icon name="send" size={18} />
        </button>
      </form>
    </div>
  );
}

function CompanyBootstrap() {
  const { t, locale } = useI18n();
  const { createCompany, busyAction } = useShellState();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <section class="setup-card">
      <img src="/assets/v3/brand-mark.png" alt="" width="54" height="54" />
      <h1>{t('bootstrap.title')}</h1>
      <p>{t('bootstrap.body')}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) {
          void createCompany(name.trim(), description.trim() || undefined, locale)
            .catch(() => undefined);
        }
      }}>
        <FormField
          label={t('bootstrap.name')}
          value={name}
          required
          autoFocus
          onInput={setName}
        />
        <FormField
          label={t('bootstrap.description')}
          value={description}
          onInput={setDescription}
        />
        <button class="primary-button" type="submit" disabled={!name.trim() || busyAction === 'create-company'}>
          {busyAction === 'create-company' ? t('bootstrap.creating') : t('bootstrap.create')}
        </button>
      </form>
    </section>
  );
}

function NewWorkForm() {
  const { t } = useI18n();
  const { createWork, busyAction } = useShellState();
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<'one-off' | 'project'>('one-off');
  const [workspaceId, setWorkspaceId] = useState('');

  return (
    <section class="setup-card setup-card--work">
      <Icon name="work" size={32} />
      <h1>{t('work.emptyTitle')}</h1>
      <p>{t('work.emptyBody')}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && objective.trim()) {
          void createWork(title.trim(), objective.trim(), workspaceId || undefined)
            .catch(() => undefined);
        }
      }}>
        <FormField label={t('work.titleLabel')} value={title} required autoFocus onInput={setTitle} />
        <label class="field">
          <span>{t('work.objectiveLabel')}</span>
          <textarea
            rows={4}
            value={objective}
            required
            onInput={(event) => setObjective(event.currentTarget.value)}
          />
        </label>
        <WorkspaceChoice
          mode={workspaceMode}
          workspaceId={workspaceId}
          onModeChange={setWorkspaceMode}
          onChange={setWorkspaceId}
        />
        <button
          class="primary-button"
          type="submit"
          disabled={
            !title.trim()
            || !objective.trim()
            || (workspaceMode === 'project' && !workspaceId)
            || busyAction === 'create-work'
          }
        >
          {busyAction === 'create-work' ? t('work.creating') : t('work.create')}
        </button>
      </form>
    </section>
  );
}

function WorkspaceChoice({
  mode,
  workspaceId,
  onModeChange,
  onChange,
}: {
  mode: 'one-off' | 'project';
  workspaceId: string;
  onModeChange: (mode: 'one-off' | 'project') => void;
  onChange: (workspaceId: string) => void;
}) {
  const { t } = useI18n();
  const { snapshot, createWorkspace, busyAction } = useShellState();
  const workspaces = snapshot.workspaces.filter((workspace) => !workspace.archivedAt);
  const [pickerError, setPickerError] = useState(false);
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);

  const chooseMode = (next: 'one-off' | 'project') => {
    onModeChange(next);
    setPickerError(false);
    if (next === 'one-off') {
      onChange('');
    } else if (!workspaceId && workspaces[0]) {
      onChange(workspaces[0].id);
    }
  };

  const addFolder = async () => {
    setPickerError(false);
    try {
      const rootPath = await pickWorkspaceFolder(
        t('workspace.pickerTitle'),
        t('workspace.pickerConfirm'),
      );
      if (!rootPath) return;
      const existing = findWorkspaceByPath(workspaces, rootPath);
      const workspace = existing ?? await createWorkspace(
        workspaceNameFromPath(rootPath),
        rootPath,
      );
      onModeChange('project');
      onChange(workspace.id);
    } catch (error) {
      if (error instanceof WorkspacePickerUnavailableError) setPickerError(true);
    }
  };

  return (
    <fieldset class="workspace-choice">
      <legend>{t('work.workspaceChoice')}</legend>
      <div class="workspace-choice-grid">
        <button
          type="button"
          class={`workspace-option ${mode === 'one-off' ? 'is-selected' : ''}`}
          aria-pressed={mode === 'one-off'}
          onClick={() => chooseMode('one-off')}
        >
          <Icon name="work" size={20} />
          <span>
            <strong>{t('work.oneOffTitle')}</strong>
            <small>{t('work.oneOffBody')}</small>
          </span>
        </button>
        <button
          type="button"
          class={`workspace-option ${mode === 'project' ? 'is-selected' : ''}`}
          aria-pressed={mode === 'project'}
          onClick={() => chooseMode('project')}
        >
          <Icon name="folder" size={20} />
          <span>
            <strong>{t('work.projectTitle')}</strong>
            <small>{t('work.projectBody')}</small>
          </span>
        </button>
      </div>

      {mode === 'project' && (
        <div class="project-folder-picker">
          {workspaces.length > 0 && (
            <label class="field">
              <span>{t('work.existingWorkspace')}</span>
              <select
                value={workspaceId}
                onChange={(event) => onChange(event.currentTarget.value)}
              >
                <option value="">{t('work.chooseWorkspace')}</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            class="secondary-button folder-picker-button"
            disabled={busyAction === 'create-workspace'}
            onClick={() => void addFolder()}
          >
            <Icon name="folder" size={16} />
            {busyAction === 'create-workspace'
              ? t('workspace.adding')
              : t('workspace.chooseFolder')}
          </button>
          {selected && (
            <p class="selected-workspace-path" title={selected.rootPath}>
              {selected.rootPath}
            </p>
          )}
          {!selected && !pickerError && (
            <p class="field-message">{t('work.projectRequired')}</p>
          )}
          {pickerError && (
            <p class="field-message field-message--error">{t('workspace.pickerUnavailable')}</p>
          )}
        </div>
      )}
    </fieldset>
  );
}

function findWorkspaceByPath(
  workspaces: Workspace[],
  rootPath: string,
): Workspace | undefined {
  const normalized = normalizeWorkspacePath(rootPath);
  return workspaces.find(
    (workspace) => normalizeWorkspacePath(workspace.rootPath) === normalized,
  );
}

function normalizeWorkspacePath(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLocaleLowerCase();
}

function FormField({
  label,
  value,
  onInput,
  required,
  autoFocus,
}: {
  label: string;
  value: string;
  onInput: (value: string) => void;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        required={required}
        autoFocus={autoFocus}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function LoadingCard() {
  const { t } = useI18n();
  return (
    <section class="setup-card setup-card--loading" role="status">
      <img src="/assets/v3/brand-mark.png" alt="" width="44" height="44" />
      <p>{t('common.loading')}</p>
    </section>
  );
}

function findMainAgent(agents: Agent[], sessionAgentId?: string): Agent | undefined {
  return agents.find((agent) => agent.id === sessionAgentId)
    ?? agents.find((agent) => /^main\s*agent$/i.test(agent.name))
    ?? agents.find((agent) => agent.status === 'active');
}

function statusLabel(work: Work):
  | 'work.running'
  | 'work.paused'
  | 'work.completed'
  | 'work.draft' {
  if (work.status === 'active') return 'work.running';
  if (work.status === 'paused') return 'work.paused';
  if (work.status === 'completed') return 'work.completed';
  return 'work.draft';
}

function stageKey(status: Mission['status']):
  | 'stage.completed'
  | 'stage.active'
  | 'stage.blocked'
  | 'stage.planned' {
  if (status === 'completed') return 'stage.completed';
  if (status === 'active') return 'stage.active';
  if (status === 'blocked') return 'stage.blocked';
  return 'stage.planned';
}

function firstSentence(content: string): string {
  return content.match(/^.*?[。！？.!?]/u)?.[0]?.trim() ?? content;
}
