import { errorMessageKey, useI18n } from './i18n.js';
import { useLayoutMode } from './layoutMode.js';
import { useShellRoute } from './router.js';
import { useShellState } from './ShellState.js';
import { CompanyActivity } from '../components/CompanyActivity.js';
import { CompanyFloor } from '../components/CompanyFloor.js';
import { LocalStatus } from '../components/LocalStatus.js';
import { Navigation } from '../components/Navigation.js';
import { WindowChrome } from '../components/WindowChrome.js';
import { CompanyPage } from '../pages/CompanyPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { WorkPage } from '../pages/WorkPage.js';

export function App() {
  const { t } = useI18n();
  const state = useShellState();
  const [route, navigate] = useShellRoute();
  const [layoutMode, setLayoutMode] = useLayoutMode();

  return (
    <div class={`app-shell mode-${layoutMode}`}>
      <a class="skip-link" href="#primary-content">{t('common.skip')}</a>
      <WindowChrome />
      <Navigation route={route} navigate={navigate} />

      <div id="primary-content" class="primary-content">
        {state.error && (
          <div class="error-banner" role="alert">
            <div>
              <strong>{t('common.error')}</strong>
              <span>{t(errorMessageKey(state.error))}</span>
            </div>
            <button type="button" onClick={() => void state.reload()}>{t('common.retry')}</button>
          </div>
        )}
        {route === 'work' && <WorkPage />}
        {route === 'company' && <CompanyPage />}
        {route === 'settings' && (
          <SettingsPage layoutMode={layoutMode} setLayoutMode={setLayoutMode} />
        )}
      </div>

      <CompanyActivity />
      <CompanyFloor />
      <LocalStatus />
    </div>
  );
}
