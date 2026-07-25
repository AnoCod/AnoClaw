import { useI18n } from '../app/i18n.js';
import type { LayoutMode } from '../app/layoutMode.js';
import { useShellState } from '../app/ShellState.js';
import { Icon } from '../components/Icon.js';

export function SettingsPage({
  layoutMode,
  setLayoutMode,
}: {
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { busyAction, updateCompanyLocale } = useShellState();

  function chooseLocale(next: 'zh-CN' | 'en-US') {
    setLocale(next);
    void updateCompanyLocale(next).catch(() => undefined);
  }

  return (
    <main class="secondary-page settings-page" tabIndex={-1}>
      <header class="secondary-page-header">
        <h1>{t('settings.title')}</h1>
        <p>{t('settings.subtitle')}</p>
      </header>

      <section class="settings-card" aria-labelledby="language-setting-title">
        <div class="settings-card-icon"><Icon name="settings" size={20} /></div>
        <div class="settings-copy">
          <h2 id="language-setting-title">{t('settings.language')}</h2>
          <p>{t('settings.languageHelp')}</p>
        </div>
        <div class="segmented-control" role="group" aria-label={t('settings.language')}>
          <button
            class={locale === 'zh-CN' ? 'is-active' : ''}
            type="button"
            aria-pressed={locale === 'zh-CN'}
            disabled={busyAction === 'update-company-locale'}
            onClick={() => chooseLocale('zh-CN')}
          >
            {t('settings.zh')}
          </button>
          <button
            class={locale === 'en-US' ? 'is-active' : ''}
            type="button"
            aria-pressed={locale === 'en-US'}
            disabled={busyAction === 'update-company-locale'}
            onClick={() => chooseLocale('en-US')}
          >
            {t('settings.en')}
          </button>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="layout-setting-title">
        <div class="settings-card-icon"><Icon name="overview" size={20} /></div>
        <div class="settings-copy">
          <h2 id="layout-setting-title">{t('settings.layout')}</h2>
          <p>{t('settings.layoutHelp')}</p>
        </div>
        <div class="segmented-control" role="group" aria-label={t('settings.layout')}>
          <button
            class={layoutMode === 'simple' ? 'is-active' : ''}
            type="button"
            aria-pressed={layoutMode === 'simple'}
            onClick={() => setLayoutMode('simple')}
          >
            {t('settings.simple')}
          </button>
          <button
            class={layoutMode === 'professional' ? 'is-active' : ''}
            type="button"
            aria-pressed={layoutMode === 'professional'}
            onClick={() => setLayoutMode('professional')}
          >
            {t('settings.professional')}
          </button>
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-card-icon"><Icon name="folder" size={20} /></div>
        <div class="settings-copy">
          <h2>{t('settings.storage')}</h2>
          <p>{t('settings.storageHelp')}</p>
        </div>
        <Icon name="active" size={12} />
      </section>
    </main>
  );
}
