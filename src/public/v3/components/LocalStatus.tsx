import { useI18n } from '../app/i18n.js';
import { useShellState } from '../app/ShellState.js';
import { Icon } from './Icon.js';

export function LocalStatus() {
  const { t } = useI18n();
  const { loading, error } = useShellState();
  const label = error
    ? t('status.unavailable')
    : loading
      ? t('status.connecting')
      : t('status.localReady');

  return (
    <footer class="local-status">
      <Icon name="active" size={12} class={error ? 'is-error' : loading ? 'is-loading' : ''} />
      <span>{label}</span>
      <span class="status-divider" aria-hidden="true" />
      <span>{t('status.localOnly')}</span>
    </footer>
  );
}
