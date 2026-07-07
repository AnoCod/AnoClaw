import { t } from '../../../i18n/index.js';
import { ToastManager } from '../../../ToastManager.js';
import type { CapabilityPluginRecommendation, TaskResolutionSummary } from '../../../types.js';

export interface TaskResolutionDelegateData {
  taskResolution: TaskResolutionSummary;
}

export class TaskResolutionDelegate {
  element: HTMLElement;

  constructor(data: TaskResolutionDelegateData) {
    this.element = this._build(data.taskResolution);
  }

  private _build(taskResolution: TaskResolutionSummary): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'task-resolution-card';
    wrapper.style.cssText = `
      margin: 8px 0 12px;
      padding: 12px;
      border: 1px solid var(--color-hairline, #242728);
      background: var(--color-surface, #0d0d0d);
      border-radius: 8px;
      color: var(--color-text-primary, #f4f4f6);
      font-size: 12px;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;';

    const titleText = document.createElement('div');
    titleText.style.cssText = 'font-size:12px;font-weight:600;';
    titleText.textContent = t('taskResolution.title');
    title.appendChild(titleText);

    const confidence = typeof taskResolution.confidence === 'number'
      ? `${Math.round(taskResolution.confidence * 100)}%`
      : '';
    if (confidence) {
      const confidenceEl = document.createElement('span');
      confidenceEl.style.cssText = 'font-size:10px;color:var(--color-text-tertiary,#6a6b6c);';
      confidenceEl.textContent = confidence;
      title.appendChild(confidenceEl);
    }
    wrapper.appendChild(title);

    const capability = taskResolution.bestCapability?.title || taskResolution.bestCapability?.id || '';
    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'color:var(--color-text-secondary,#cdcdcd);line-height:1.5;margin-bottom:10px;';
    subtitle.textContent = t('taskResolution.subtitle', { capability });
    wrapper.appendChild(subtitle);

    const recommendations = taskResolution.pluginRecommendations || [];
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    for (const plugin of recommendations) {
      list.appendChild(this._buildPluginRow(plugin));
    }
    wrapper.appendChild(list);

    const missingTools = taskResolution.missingTools || [];
    if (missingTools.length > 0) {
      const tools = document.createElement('div');
      tools.style.cssText = 'margin-top:10px;color:var(--color-text-tertiary,#6a6b6c);font-size:11px;line-height:1.45;';
      tools.textContent = t('taskResolution.missingTools', { tools: missingTools.join(', ') });
      wrapper.appendChild(tools);
    }

    return wrapper;
  }

  private _buildPluginRow(plugin: CapabilityPluginRecommendation): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display:grid;
      grid-template-columns:minmax(0,1fr) auto;
      gap:10px;
      align-items:center;
      padding:8px;
      border:1px solid rgba(255,255,255,0.08);
      border-radius:6px;
      background:rgba(255,255,255,0.025);
    `;

    const main = document.createElement('div');
    main.style.cssText = 'min-width:0;';

    const name = document.createElement('div');
    name.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';

    const label = document.createElement('span');
    label.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    label.textContent = plugin.displayName || plugin.pluginName;
    name.appendChild(label);

    const status = document.createElement('span');
    status.style.cssText = `
      flex-shrink:0;
      font-size:10px;
      color:var(--color-text-tertiary,#6a6b6c);
      border:1px solid rgba(255,255,255,0.1);
      border-radius:4px;
      padding:1px 5px;
    `;
    status.textContent = statusLabel(plugin.status);
    name.appendChild(status);
    main.appendChild(name);

    if (plugin.description || plugin.errorMessage) {
      const desc = document.createElement('div');
      desc.style.cssText = 'margin-top:3px;color:var(--color-text-tertiary,#6a6b6c);font-size:11px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      desc.textContent = plugin.errorMessage || plugin.description || '';
      main.appendChild(desc);
    }

    row.appendChild(main);
    row.appendChild(this._buildActionButton(plugin));
    return row;
  }

  private _buildActionButton(plugin: CapabilityPluginRecommendation): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = actionLabel(plugin);
    button.style.cssText = `
      height:28px;
      padding:0 10px;
      border:1px solid rgba(255,255,255,0.14);
      border-radius:6px;
      background:${plugin.action === 'install' || plugin.action === 'activate' ? '#ffffff' : 'transparent'};
      color:${plugin.action === 'install' || plugin.action === 'activate' ? '#000000' : 'var(--color-text-primary,#f4f4f6)'};
      font-size:11px;
      font-weight:600;
      cursor:pointer;
      white-space:nowrap;
    `;

    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = button.textContent || '';
      button.textContent = '...';
      try {
        await runPluginAction(plugin);
        ToastManager.getInstance().success(t('taskResolution.actionDone'));
        window.dispatchEvent(new CustomEvent('anoclaw:plugins-changed', { detail: { pluginName: plugin.pluginName } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ToastManager.getInstance().error(t('taskResolution.actionFailed', { message }));
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });

    return button;
  }
}

async function runPluginAction(plugin: CapabilityPluginRecommendation): Promise<void> {
  if (plugin.action === 'activate' || plugin.action === 'reload') {
    const action = plugin.action === 'activate' ? 'activate' : 'reload';
    await postJson(plugin.activateRoute || '/api/v1/plugins/reload', { name: plugin.pluginName, action });
    return;
  }

  if (plugin.action === 'install' && plugin.installUrl) {
    await postJson(plugin.installRoute || '/api/v1/plugins/install', {
      name: plugin.pluginName,
      url: plugin.installUrl,
    });
    await postJson('/api/v1/plugins/reload', { name: plugin.pluginName, action: 'activate' }).catch(() => {});
    return;
  }

  window.location.hash = '#plugins';
}

async function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const data = await resp.json() as { error?: string; message?: string };
      message = data.message || data.error || message;
    } catch {}
    throw new Error(message);
  }
}

function actionLabel(plugin: CapabilityPluginRecommendation): string {
  if (plugin.action === 'activate') return t('taskResolution.activate');
  if (plugin.action === 'install') return t('taskResolution.install');
  if (plugin.action === 'reload') return t('taskResolution.reload');
  if (plugin.action === 'inspect') return t('taskResolution.inspect');
  return t('taskResolution.openPlugins');
}

function statusLabel(status: CapabilityPluginRecommendation['status']): string {
  if (status === 'activated') return t('taskResolution.status.activated');
  if (status === 'installed') return t('taskResolution.status.installed');
  if (status === 'missing') return t('taskResolution.status.missing');
  if (status === 'error') return t('taskResolution.status.error');
  return t('taskResolution.status.unknown');
}
