// SetupWizard - first-run LLM configuration modal.
// Checks: settings.yaml has apiKey and a MainAgent config exists.
// If either is missing, shows a setup form before the main window.
// User must fill in + test connection, or the app quits.

import * as path from 'path';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { app } from 'electron';
import type { BrowserWindow, IpcMain } from 'electron';
import { DEFAULT_MAIN_AGENT_ID } from '../shared/constants.js';
import { buildDefaultAgentConfigs } from '../server/core/agent/DefaultAgentTemplate.js';
import type { AgentConfigWithKey } from '../server/core/agent/AgentConfig.js';

let _Bw: typeof BrowserWindow | null = null;
let _ipcMain: IpcMain | null = null;

export function init(BrowserWindow: typeof import('electron').BrowserWindow, ipcMain: IpcMain): void {
  _Bw = BrowserWindow;
  _ipcMain = ipcMain;
}

const appRoot = () => app.getAppPath();
/** In packaged mode, writable dirs are at app.asar.unpacked/. In dev mode, this is a no-op. */
const writableRoot = () => appRoot().replace(/\\/g, '/').includes('.asar') ? appRoot() + '.unpacked' : appRoot();

/**
 * Check if AnoClaw is already configured (first-run = needs setup).
 */
export function needsSetup(): boolean {
  const settingsPath = path.join(writableRoot(), 'config', 'settings.yaml');
  try {
    const parsed = YAML.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown> | null;
    const llm = parsed?.llm && typeof parsed.llm === 'object'
      ? parsed.llm as Record<string, unknown>
      : parsed || {};
    const provider = String(llm.provider || 'openai-compatible');
    const hasRequiredCredentials = provider === 'ollama' || Boolean(String(llm.apiKey || '').trim());
    if (!hasRequiredCredentials) return true;
  } catch {
    return true;
  }

  const agentsDir = path.join(writableRoot(), 'data', 'agents');
  const modernMainPath = path.join(agentsDir, `${DEFAULT_MAIN_AGENT_ID}.json`);
  const legacyMainPath = path.join(agentsDir, 'ceo.json');
  if (!fs.existsSync(modernMainPath) && !fs.existsSync(legacyMainPath)) return true;

  return false;
}

function filterKnownTools(config: AgentConfigWithKey, availableToolNames: Set<string> | null): AgentConfigWithKey {
  if (!availableToolNames) return config;
  return {
    ...config,
    allowedTools: config.allowedTools.filter((tool) => availableToolNames.has(tool)),
  };
}

/**
 * Show the setup wizard. Returns a Promise that resolves when setup is complete,
 * or quits the app if the user cancels.
 */
export function runSetupWizard(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!_Bw || !_ipcMain) return reject(new Error('SetupWizard not initialized'));
    const ipc = _ipcMain;

    const htmlPath = path.join(appRoot(), 'src', 'electron', 'setup-wizard.html');
    const fallbackPath = path.join(appRoot(), 'dist', 'electron', 'setup-wizard.html');
    const finalHtmlPath = fs.existsSync(htmlPath) ? htmlPath :
      fs.existsSync(fallbackPath) ? fallbackPath : null;
    if (!finalHtmlPath) {
      return reject(new Error(`Setup wizard HTML not found`));
    }

    const win = new _Bw({
      width: 520,
      height: 680,
      minWidth: 420,
      minHeight: 560,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      title: 'AnoClaw Setup',
      frame: true,
      show: false,
      webPreferences: {
        preload: path.join(appRoot(), 'dist', 'electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.setMenuBarVisibility(false);
    // IPC handlers
    ipc.handle('save-setup', async (_e: any, data: {
      agentName: string; model: string; apiUrl: string; apiKey: string;
      provider: string; contextWindow: number;
    }) => {
      try {
        const root = writableRoot(); // write to unpacked dir when packaged
        const provider = data.provider || 'openai-compatible';
        const ctxWindow = data.contextWindow || 131072;
        const apiUrl = provider === 'ollama' ? (data.apiUrl || 'http://localhost:11434')
          : provider === 'openai' ? 'https://api.openai.com'
          : provider === 'anthropic' ? 'https://api.anthropic.com'
          : data.apiUrl;

        // 1. Write settings.yaml
        const configDir = path.join(root, 'config');
        fs.mkdirSync(configDir, { recursive: true });
        const settingsPath = path.join(configDir, 'settings.yaml');
        let existingSettings: Record<string, unknown> = {};
        try {
          existingSettings = YAML.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown> || {};
        } catch { /* first setup or invalid legacy file */ }
        for (const legacyKey of ['provider', 'apiUrl', 'apiKey', 'model', 'contextWindow']) {
          delete existingSettings[legacyKey];
        }
        const existingPort = Number(existingSettings.port);
        const existingApiPort = Number(existingSettings.apiPort);
        const yaml = YAML.stringify({
          ...existingSettings,
          port: Number.isInteger(existingPort) && existingPort > 0 && existingPort <= 65535 ? existingPort : 3456,
          host: typeof existingSettings.host === 'string' ? existingSettings.host : '127.0.0.1',
          apiPort: Number.isInteger(existingApiPort) && existingApiPort > 0 && existingApiPort <= 65535 ? existingApiPort : 15730,
          llm: {
            ...(existingSettings.llm && typeof existingSettings.llm === 'object'
              ? existingSettings.llm as Record<string, unknown>
              : {}),
            provider,
            apiUrl,
            apiKey: data.apiKey || '',
            model: data.model,
            contextWindow: ctxWindow,
          },
        }, { indent: 2, lineWidth: 0 });
        const tempSettingsPath = path.join(configDir, `.settings.yaml.${process.pid}.${Date.now()}.tmp`);
        try {
          const fd = fs.openSync(tempSettingsPath, 'wx', 0o600);
          try {
            fs.writeFileSync(fd, yaml, 'utf8');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(tempSettingsPath, settingsPath);
        } finally {
          fs.rmSync(tempSettingsPath, { force: true });
        }

        // 2. Write MainAgent config
        const agentsDir = path.join(root, 'data', 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });

        const { encryptApiKey } = await import('../server/core/agent/AgentConfig.js');
        const agentName = data.agentName || 'MainAgent';

        // Read available tool names from the running ToolRegistry (already started)
        let availableToolNames: Set<string> | null = null;
        try {
          const { ToolRegistry } = await import('../server/core/tools/ToolRegistry.js');
          availableToolNames = new Set(ToolRegistry.getInstance().allToolNames());
        } catch {
          // ToolRegistry not available - use sensible defaults.
        }

        // Default agent organization, matching the dev first-run template.
        const configs = buildDefaultAgentConfigs({
          agentName,
          provider,
          apiUrl,
          apiKey: data.apiKey || '',
          model: data.model,
          contextWindow: ctxWindow,
        }).map((config) => filterKnownTools(config, availableToolNames));

        for (const config of configs) {
          fs.writeFileSync(
            path.join(agentsDir, `${config.id}.json`),
            JSON.stringify({ ...config, apiKey: config.apiKey ? encryptApiKey(config.apiKey) : '' }, null, 2),
            'utf-8',
          );
        }

        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    let setupCompleted = false;
    const cleanupIpc = () => {
      ipc.removeHandler('save-setup');
      ipc.removeListener('setup-done', onSetupDone);
      ipc.removeListener('quit-setup', onQuitSetup);
    };

    const onSetupDone = () => {
      if (setupCompleted) return;
      setupCompleted = true;
      cleanupIpc();
      if (!win.isDestroyed()) win.close();
      resolve();
    };

    const onQuitSetup = () => {
      cleanupIpc();
      if (!win.isDestroyed()) win.close();
      else app.quit();
    };

    ipc.on('setup-done', onSetupDone);
    ipc.on('quit-setup', onQuitSetup);

    win.loadFile(finalHtmlPath);

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    win.on('closed', () => {
      cleanupIpc();
      if (!setupCompleted) app.quit();
    });
  });
}
