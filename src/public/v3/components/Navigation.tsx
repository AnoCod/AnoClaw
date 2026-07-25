import type { ShellRoute } from '../model.js';
import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import { Icon, type IconName } from './Icon.js';

const NAV_ITEMS: Array<{ route: ShellRoute; icon: IconName; label: 'nav.work' | 'nav.company' | 'nav.settings' }> = [
  { route: 'work', icon: 'work', label: 'nav.work' },
  { route: 'company', icon: 'company', label: 'nav.company' },
  { route: 'settings', icon: 'settings', label: 'nav.settings' },
];

export function Navigation({
  route,
  navigate,
}: {
  route: ShellRoute;
  navigate: (route: ShellRoute) => void;
}) {
  const { t, formatTime, formatDate } = useI18n();
  const { snapshot, selectedWork, selectWork } = useShellState();
  const recentWorks = [...snapshot.works]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6);

  return (
    <aside class="navigation" aria-label={t('nav.primary')}>
      <div class="brand-row">
        <img class="brand-mark" src="/assets/v3/brand-mark.png" alt="" width="32" height="32" />
        <span>{t('brand.name')}</span>
      </div>

      <nav class="primary-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.route}
            class={`nav-button ${route === item.route ? 'is-active' : ''}`}
            type="button"
            aria-current={route === item.route ? 'page' : undefined}
            onClick={() => navigate(item.route)}
          >
            <Icon name={item.icon} size={21} />
            <span>{t(item.label)}</span>
          </button>
        ))}
      </nav>

      <section class="recent-work" aria-labelledby="recent-work-title">
        <h2 id="recent-work-title">{t('nav.recent')}</h2>
        <div class="recent-work-list">
          {recentWorks.length === 0 && <p class="quiet-copy">{t('nav.noRecent')}</p>}
          {recentWorks.map((work) => (
            <button
              key={work.id}
              class={`recent-work-item ${selectedWork?.id === work.id ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                selectWork(work.id);
                navigate('work');
              }}
            >
              <span class="recent-work-icon"><Icon name="work" size={14} /></span>
              <span class="recent-work-copy">
                <strong>{work.title}</strong>
                <small>
                  {sameLocalDay(work.updatedAt)
                    ? formatTime(work.updatedAt)
                    : formatDate(work.updatedAt)}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function sameLocalDay(value: string): boolean {
  const date = new Date(value);
  const today = new Date();
  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}
