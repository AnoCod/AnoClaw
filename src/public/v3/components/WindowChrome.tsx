import { Icon } from './Icon.js';
import { useI18n } from '../app/i18n.js';

interface ElectronWindowApi {
  windowMinimizeAnimate?: () => void;
  windowMaximize?: () => void;
  windowClose?: () => void;
}

export function WindowChrome() {
  const { t } = useI18n();
  const api = (window as typeof window & { electronAPI?: ElectronWindowApi }).electronAPI;

  return (
    <div class="window-chrome" aria-label={t('chrome.controls')}>
      <button
        class="window-button"
        type="button"
        aria-label={t('chrome.minimize')}
        title={t('chrome.minimize')}
        onClick={() => api?.windowMinimizeAnimate?.()}
      >
        <Icon name="minimize" size={12} />
      </button>
      <button
        class="window-button"
        type="button"
        aria-label={t('chrome.maximize')}
        title={t('chrome.maximize')}
        onClick={() => api?.windowMaximize?.()}
      >
        <Icon name="maximize" size={11} />
      </button>
      <button
        class="window-button window-button--close"
        type="button"
        aria-label={t('chrome.close')}
        title={t('chrome.close')}
        onClick={() => api?.windowClose?.()}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
