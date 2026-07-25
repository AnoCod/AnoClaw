import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { useI18n } from '../app/i18n.js';
import {
  buildSessionTree,
  type SessionTreeNode,
} from '../app/sessionTransparency.js';
import type { Agent, Session, Task, Work } from '../model.js';
import { AgentAvatar } from './AgentAvatar.js';
import { Icon } from './Icon.js';

export function SessionInspector({
  work,
  sessions,
  tasks,
  agents,
  selectedSessionId,
  onSelect,
  onClose,
}: {
  work: Work;
  sessions: Session[];
  tasks: Task[];
  agents: Agent[];
  selectedSessionId: string;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tree = useMemo(
    () => buildSessionTree(sessions, work.primarySessionId),
    [sessions, work.primarySessionId],
  );
  const taskMap = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const runCount = sessions.filter((session) => session.kind === 'run').length;

  return (
    <section class="session-inspector" aria-labelledby="session-inspector-title">
      <header>
        <div>
          <span class="session-inspector-kicker">{t('session.transparency')}</span>
          <h2 id="session-inspector-title">{t('session.title')}</h2>
          <p>{t('session.subtitle')}</p>
        </div>
        <div class="session-inspector-summary">
          <span>{t('session.runCount').replace('{count}', String(runCount))}</span>
          <button
            class="icon-button"
            type="button"
            aria-label={t('session.close')}
            title={t('session.close')}
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      <div class="session-tree" role="tree" aria-label={t('session.title')}>
        {tree.length === 0
          ? <p class="session-tree-empty">{t('session.none')}</p>
          : tree.map((node) => (
            <SessionNode
              key={node.session.id}
              node={node}
              depth={0}
              selectedSessionId={selectedSessionId}
              taskMap={taskMap}
              agentMap={agentMap}
              onSelect={onSelect}
            />
          ))}
      </div>
    </section>
  );
}

function SessionNode({
  node,
  depth,
  selectedSessionId,
  taskMap,
  agentMap,
  onSelect,
}: {
  node: SessionTreeNode;
  depth: number;
  selectedSessionId: string;
  taskMap: Map<string, Task>;
  agentMap: Map<string, Agent>;
  onSelect: (sessionId: string) => void;
}) {
  const { t, formatTime } = useI18n();
  const { session } = node;
  const agent = agentMap.get(session.agentId);
  const avatarAgent = agent ?? {
    name: session.actorSnapshot.name,
    capabilities: session.actorSnapshot.capabilities,
  };
  const task = session.taskId ? taskMap.get(session.taskId) : undefined;
  const isPrimary = session.kind === 'primary';

  return (
    <div class="session-tree-branch" role="group">
      <button
        class={`session-tree-item ${depth > 0 ? 'is-child' : ''} ${selectedSessionId === session.id ? 'is-selected' : ''}`}
        type="button"
        role="treeitem"
        aria-selected={selectedSessionId === session.id}
        style={{ '--session-indent': `${depth * 25}px` } as JSX.CSSProperties}
        onClick={() => onSelect(session.id)}
      >
        <span class="session-tree-line" aria-hidden="true" />
        <AgentAvatar agent={avatarAgent} size="small" />
        <span class="session-tree-copy">
          <strong>
            {session.actorSnapshot.name}
            {isPrimary && <em>{t('session.primaryBadge')}</em>}
          </strong>
          <small>
            {task?.title
              ?? (isPrimary ? t('session.mainConversation') : t('session.unlinkedRun'))}
          </small>
        </span>
        <span class={`session-state session-state--${session.status}`}>
          <i />
          {t(statusKey(session.status))}
        </span>
        <time dateTime={session.createdAt}>{formatTime(session.createdAt)}</time>
      </button>
      {node.children.map((child) => (
        <SessionNode
          key={child.session.id}
          node={child}
          depth={depth + 1}
          selectedSessionId={selectedSessionId}
          taskMap={taskMap}
          agentMap={agentMap}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function statusKey(status: Session['status']):
  | 'session.active'
  | 'session.idle'
  | 'session.closed' {
  if (status === 'active') return 'session.active';
  if (status === 'closed') return 'session.closed';
  return 'session.idle';
}
