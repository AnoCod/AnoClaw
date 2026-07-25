import { render } from 'preact';
import { App } from './app/App.js';
import { I18nProvider } from './app/i18n.js';
import { ShellStateProvider } from './app/ShellState.js';

const root = document.getElementById('app');
if (!root) throw new Error('AnoClaw shell root was not found');

render(
  <I18nProvider>
    <ShellStateProvider>
      <App />
    </ShellStateProvider>
  </I18nProvider>,
  root,
);
