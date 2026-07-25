
// HTTP + WebSocket server: serves API, static files, real-time agent communication

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DEFAULT_HOST, APP_NAME, APP_VERSION } from '../shared/constants.js';
import { WsServer } from './infra/network/WsServer.js';
import { AgentRegistry } from './core/agent/AgentRegistry.js';
import { AgentRuntime } from './core/agent/AgentRuntime.js';
import { SessionManager } from './core/session/SessionManager.js';
import { ToolRegistry } from './core/tools/ToolRegistry.js';
import { ToolProfiler } from './infra/supervision/ToolProfiler.js';
import { PromptAssembler } from './core/prompt/PromptAssembler.js';
import { CommandRegistry } from './core/commands/CommandRegistry.js';
import { LogManager } from './infra/logging/LogManager.js';
import { initAuthStore } from './gateway/ApiAuth.js';
import { SettingsManager } from './infra/storage/SettingsManager.js';
import { serveStatic } from './infra/StaticFiles.js';
import { writablePath, ensureWritableDir, appPath } from './infra/WritablePath.js';

// Set cwd to the unpacked root when packaged (asar is read-only).
// In dev mode, REPO_ROOT is the real project directory.
const REPO_ROOT = writablePath();
process.chdir(REPO_ROOT);


// process.cwd() is the unpacked root (or project root in dev) and won't find these.
const PUBLIC_DIR = appPath('src', 'public');
let v3RealtimeBridge: import('./core/v3/events/V3RealtimeBridge.js').V3RealtimeBridge | null = null;
let v3Scheduler: import('./core/v3/orchestration/CoordinationScheduler.js').CoordinationScheduler | null = null;


function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '::1'].includes(hostname)
      && [DEFAULT_PORT, 15730].includes(port);
  } catch {
    return false;
  }
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (isAllowedLocalOrigin(origin) && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function safePathSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || /[/\\]/.test(value) || /[<>:"|?*]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function safeRelativeFilePath(value: string): string {
  const normalized = path.normalize(value);
  if (
    !value ||
    path.isAbsolute(value) ||
    normalized.startsWith('..') ||
    normalized.includes(`..${path.sep}`) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(value)
  ) {
    throw new Error('Invalid file path');
  }
  return normalized;
}


async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
  setCors(req, res);
  const url = req.url || '/';

  if (!isAllowedLocalOrigin(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', message: 'Cross-origin localhost API requests are not allowed' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      agents: AgentRegistry.getInstance().allAgents().length,
      tools: ToolRegistry.getInstance().allTools().length,
    }));
    return;
  }

  // Plugin management endpoints

  const pluginDeleteMatch = url.match(/^\/api\/v1\/plugins\/([a-zA-Z0-9_\-\.]+)$/);
  if (pluginDeleteMatch && req.method === 'DELETE') {
    const name = pluginDeleteMatch[1];
    try {
      const pluginDir = writablePath('plugins', name);
      if (!fs.existsSync(pluginDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plugin not found' }));
        return;
      }
      let deactivateWarning = '';
      try {
        const { PluginHostManager: PM } = await import('./core/plugin-host/PluginHostManager.js');
        await PM.getInstance().deactivatePlugin(name);
      } catch (err) {
        deactivateWarning = err instanceof Error ? err.message : String(err);
      }
      // Move to .disabled instead of deleting (recoverable)
      const disabledDir = writablePath('plugins', `${name}.disabled`);
      if (fs.existsSync(disabledDir)) fs.rmSync(disabledDir, { recursive: true, force: true });
      fs.renameSync(pluginDir, disabledDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name,
        status: 'uninstalled',
        recoverable: true,
        ...(deactivateWarning ? { warning: `Plugin was moved, but deactivation cleanup reported: ${deactivateWarning}` } : {}),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Uninstall failed', message: msg }));
    }
    return;
  }
  if (url === '/api/v1/plugins/market' && req.method === 'GET') {
    try {
      const mktPath = path.resolve(process.cwd(), 'plugins-market.json');
      if (fs.existsSync(mktPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fs.readFileSync(mktPath, 'utf-8'));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plugins: [] }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load marketplace' }));
    }
    return;
  }
  if (url === '/api/v1/plugins' && req.method === 'GET') {
    try {
      const { PluginHostManager: PM } = await import('./core/plugin-host/PluginHostManager.js');
      const plugins = await PM.getInstance().listPlugins();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plugins, total: plugins.length }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Plugin list failed', message: msg }));
    }
    return;
  }
  if (url === '/api/v1/plugins/reload' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const name = body.name as string;
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "name" field' }));
          return;
        }
        const { PluginHostManager: PM } = await import('./core/plugin-host/PluginHostManager.js');
        const pm = PM.getInstance();
        const action = (body.action as string) || 'reload';
        let state;
        switch (action) {
          case 'activate':
            state = await pm.activatePlugin(name);
            break;
          case 'deactivate':
            state = await pm.deactivatePlugin(name);
            break;
          default:
            state = await pm.reloadPlugin(name);
            break;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reload failed', message: msg }));
      }
    });
    return;
  }

  // Plugin install from URL (supports raw JSON or GitHub repos)
  if (url === '/api/v1/plugins/install' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const installUrl = body.url as string;
        if (!installUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "url" field' }));
          return;
        }
        const destName = body.name ? safePathSegment(String(body.name), 'plugin name') : `plugin-${Date.now().toString(36)}`;
        const destDir = writablePath('plugins', destName);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        // GitHub repo install: convert github.com/owner/repo to raw URLs
        const githubMatch = installUrl.match(/github\.com\/([^\/]+)\/([^\/\s#]+)/);
        if (githubMatch) {
          const [, owner, repoSlug] = githubMatch;
          const repo = repoSlug.replace(/\.git$/, '');
          const branch = encodeURIComponent(body.branch as string || 'main');
          const files = ['plugin.json', 'extension.js', 'frontend/index.html'];
          let fetched = 0;
          for (const f of files) {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f}`;
            try {
              const r = await fetch(rawUrl);
              if (r.ok) {
                const content = await r.text();
                const fullPath = path.join(destDir, f);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(fullPath, content);
                fetched++;
              }
            } catch {}
          }
          if (fetched === 0) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No plugin files found in GitHub repo' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: destName, path: destDir, installed: true, files: fetched, source: 'github' }));
          return;
        }

        // Raw JSON install: { files: { "extension.js": "...", "plugin.json": "..." } }
        const resp = await fetch(installUrl);
        if (!resp.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Fetch failed: HTTP ${resp.status}` }));
          return;
        }
        const data = await resp.json() as { files: Record<string, string> };
        for (const [filePath, fileContent] of Object.entries(data.files)) {
          const fullPath = path.join(destDir, safeRelativeFilePath(filePath));
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, fileContent);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: destName, path: destDir, installed: true }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Install failed', message: msg }));
      }
    });
    return;
  }


  if (url === '/api/skills') {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const name = (body.name as string || 'untitled').replace(/[^a-z0-9_-]/gi, '_');
          const frontmatter = [
            '---',
            `name: "${body.name || 'Untitled'}"`,
            `description: "${body.description || ''}"`,
            'type: custom',
            '---',
            '',
          ].join('\n');
          const content = frontmatter + (body.content as string || '');
          const skillDir = writablePath('skills', name);
          if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
          const filePath = path.join(skillDir, 'SKILL.md');
          fs.writeFileSync(filePath, content);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: name, name: body.name, status: 'imported' }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON', message: (err as Error).message }));
        }
      });
      return;
    }

    const skillsDir = path.resolve(process.cwd(), 'skills');
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const skillFiles: Array<{ path: string; id: string }> = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            skillFiles.push({ path: skillMd, id: entry.name });
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          skillFiles.push({ path: path.join(skillsDir, entry.name), id: entry.name.replace('.md', '') });
        }
      }

      const skills = skillFiles.map(({ path: filePath, id }) => {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const match = raw.match(/^---\n([\s\S]*?)\n---/);
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
        const frontmatter: Record<string, unknown> = {};
        if (match) {
          for (const line of match[1].split('\n')) {
            const kv = line.match(/^(\w+):\s*(.+)/);
            if (kv) frontmatter[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
          }
        }
        return {
          id,
          name: frontmatter.name || id,
          description: frontmatter.description || '',
          content: body,
          enabled: true,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(skills));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
    return;
  }


  const skillsPatchMatch = url.match(/^\/api\/skills\/([a-zA-Z0-9_-]+)$/);
  if (skillsPatchMatch && req.method === 'PATCH') {
    const skillId = skillsPatchMatch[1];
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const skillsDir = path.resolve(process.cwd(), 'skills');
        // Try nested standard format first, then deprecated flat
        let filePath = path.join(skillsDir, skillId, 'SKILL.md');
        if (!fs.existsSync(filePath)) {
          filePath = path.join(skillsDir, `${skillId}.md`);
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }
        let raw = fs.readFileSync(filePath, 'utf-8');
        const match = raw.match(/^---\n([\s\S]*?)\n---/);
        if (match && body.enabled !== undefined) {
          const newFrontmatter = match[1].replace(/^enabled:.*$/m, `enabled: ${body.enabled}`);
          raw = raw.replace(match[1], newFrontmatter);
          fs.writeFileSync(filePath, raw);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: skillId, enabled: body.enabled }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }


  if (url.startsWith('/api/')) {
    const { ApiServer } = await import('./gateway/ApiServer.js');
    await ApiServer.getInstance().handleApiRequest(req, res);
    return;
  }


  if (url.startsWith('/ws')) {
    res.writeHead(426, {
      'Content-Type': 'text/plain',
      'Upgrade': 'websocket',
    });
    res.end('Upgrade Required');
    return;
  }

  // Serve plugin frontend files from plugins/ directory
  if (url.startsWith('/plugins/')) {
    serveStatic(res, url.slice(9), writablePath('plugins'));
    return;
  }

  serveStatic(res, url, PUBLIC_DIR);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error', message: (err as Error).message }));
    }
  }
}


async function initialize(): Promise<void> {
  // 1. Initialize logging
  const logManager = LogManager.getInstance();
  logManager.initialize('logs');

  // 1.5 Load settings from config/settings.yaml (merged with defaults)
  const settings = SettingsManager.getInstance();
  await settings.load();

  // Apply logging.level from settings
  logManager.setMinLevel(settings.get<string>('logging.level', 'info'));


  // Persistent v3 Agents live only in the company event stream. Runtime Agent
  // objects are registered lazily for an active turn and never loaded from
  // the retired data/agents v2 directory.
  const registry = AgentRegistry.getInstance();
  logManager.logger('anochat.core').info('Clean v3 runtime Agent registry initialized');

  // 3. Register all tools (built-in tools auto-discovered from builtin/)
  const { registerAllTools } = await import('./bootstrap/ToolRegistrar.js');
  await registerAllTools(ToolRegistry.getInstance());

  // 3.5 Register all slash commands
  const { registerAllCommands } = await import('./bootstrap/CommandRegistrar.js');
  await registerAllCommands(CommandRegistry.getInstance());

  // 3.6 Register declarative HTTP routes
  const { registerAllRoutes } = await import('./gateway/routes/registerAllRoutes.js');
  const { ApiServer: ApiServerClass } = await import('./gateway/ApiServer.js');
  registerAllRoutes(ApiServerClass.getInstance());

  // 4. Keep the legacy SessionManager only as an internal AgentLoop
  // compatibility service. It starts from a clean v3-owned directory and is
  // not a public source of truth; v3 Session transcripts remain authoritative.
  const sessionManager = SessionManager.getInstance();
  try {
    await sessionManager.initialize(ensureWritableDir('data', 'v3', 'runtime-compat', 'sessions'));
    const reconciledStatuses = await sessionManager.reconcileRuntimeStatuses();
    logManager.logger('anochat.core').info('AgentLoop compatibility sessions initialized', {
      reconciledStatuses,
    });
  } catch (err) {
    logManager.logger('anochat.core').error('SessionManager initialization failed', { error: (err as Error).message });
    throw err;
  }

  // 4.2 Build one shared v3 repository graph for REST, primary turns,
  // realtime replay, and (below) the event-driven scheduler.
  const v3Root = ensureWritableDir('data', 'v3');
  const {
    CompanyRepository,
    SessionTranscriptRepository,
    WorkRepository,
  } = await import('./core/v3/store/index.js');
  const { V3PrimaryTurnCoordinator } = await import(
    './core/v3/execution/V3PrimaryTurnCoordinator.js'
  );
  const { createRepositoryV3Services } = await import('./api/v3/RepositoryServices.js');
  const companyRepository = new CompanyRepository(v3Root);
  const workRepository = new WorkRepository(v3Root);
  const transcriptRepository = new SessionTranscriptRepository(v3Root);
  const primaryTurnCoordinator = new V3PrimaryTurnCoordinator({
    companyRepository,
    workRepository,
    transcriptRepository,
  });
  const { V3RunAgentTurnExecutor } = await import(
    './core/v3/orchestration/V3RunAgentTurnExecutor.js'
  );
  const { V3RepositoryWorkspacePreparer } = await import(
    './core/v3/workspace/V3RepositoryWorkspacePreparer.js'
  );
  const { V3RunExecutor } = await import('./core/v3/orchestration/V3RunExecutor.js');
  const { CoordinationScheduler } = await import(
    './core/v3/orchestration/CoordinationScheduler.js'
  );
  const runExecutor = new V3RunExecutor({
    companyRepository,
    workRepository,
    turnExecutor: new V3RunAgentTurnExecutor({
      companyRepository,
      workRepository,
      transcriptRepository,
    }),
    workspacePreparer: new V3RepositoryWorkspacePreparer({
      workRepository,
      leaseTtlMs: settings.get<number>('coordination.workspaceLeaseTtlMs', 30_000),
    }),
    maxTaskRuntimeMs: settings.get<number>('coordination.maxTaskRuntimeMs', 600_000),
  });
  ApiServerClass.getInstance().configureV3Services(createRepositoryV3Services(v3Root, {
    companyRepository,
    workRepository,
    transcriptRepository,
    runExecutor,
    primaryTurnDispatcher: primaryTurnCoordinator,
  }));

  const { AppendOnlyEventStore } = await import('./core/v3/store/AppendOnlyEventStore.js');
  const { V3RealtimeBridge } = await import('./core/v3/events/V3RealtimeBridge.js');
  v3RealtimeBridge = new V3RealtimeBridge(
    wsServer,
    new AppendOnlyEventStore(v3Root),
  );
  v3RealtimeBridge.start();
  v3Scheduler = new CoordinationScheduler({
    companyRepository,
    workRepository,
    runExecutor,
  });
  const { configureV3WorkToolDependencies } = await import(
    './core/tools/v3/V3WorkToolSupport.js'
  );
  configureV3WorkToolDependencies({
    companyRepository,
    workRepository,
    transcriptRepository,
    wakeSafeTurnBoundary: runExecutor.wakeSafeTurnBoundary,
    stopTask: (workId, taskId, reason) => (
      v3Scheduler
        ? v3Scheduler.stopTask(workId, taskId, reason)
        : runExecutor.stop(workId, taskId, reason)
    ),
  });
  await v3Scheduler.start();
  logManager.logger('anochat.core').info('Persistent v3 service graph and scheduler initialized');

  // 4.5 Initialize API auth tokens
  await initAuthStore('config');


  // 5. Gateway adapters registered later (after PluginHost starts, gated by plugin existence)

  // 10. Load skills into SkillManager (for SkillTool + auto-detection)
  try {
    const { SkillManager } = await import('./core/skills/SkillManager.js');
    const { SkillSource } = await import('./core/skills/Skill.js');
    const skillsDir = path.resolve(process.cwd(), 'skills');
    const sm = SkillManager.getInstance();
    await sm.loadFromDirectory(skillsDir, SkillSource.Project);
    // Also load user-level skills from ~/.anoclaw/skills/
    await sm.loadUserSkills();
    logManager.logger('anochat.core').info('Skills loaded', { count: sm.count });
  } catch (err) {
    logManager.logger('anochat.core').warn('Skill loading failed', { error: (err as Error).message });
  }

  // 10.5 Start Plugin Host (Worker Thread for plugin system)
  try {
    const { PluginHostManager } = await import('./core/plugin-host/PluginHostManager.js');
    const pm = PluginHostManager.getInstance();
    pm.start();
    logManager.logger('anochat.core').info('PluginHost started');
  } catch (err) {
    logManager.logger('anochat.core').warn('PluginHost start failed', { error: (err as Error).message });
  }


  try {
    const { ExtensionManager } = await import('./core/extensible/ExtensionManager.js');
    const extMgr = ExtensionManager.getInstance();


    const { SkillsExtension } = await import('./core/skills/SkillsExtension.js');
    const { MemoryExtension } = await import('./core/memory/MemoryExtension.js');
    const { EvolutionExtension } = await import('./core/evolution/EvolutionExtension.js');
    extMgr.register(new SkillsExtension());
    extMgr.register(new MemoryExtension());
    extMgr.register(new EvolutionExtension());

    await extMgr.startAll();

    logManager.logger('anochat.core').info('Extensions started', {
      registered: extMgr.registeredIds.length,
      started: extMgr.registeredIds.filter(id => extMgr.isStarted(id)).length,
    });
  } catch (err) {
    logManager.logger('anochat.core').warn('Extension loading failed', { error: (err as Error).message });
  }
  // Gateway adapters are registered by the anoclaw-gateway plugin via extension.js


  try {
    AgentRegistry.getInstance().setLogger(logManager.logger('anochat.agent'));
    ToolRegistry.getInstance().setLogger(logManager.logger('anochat.tools'));
    PromptAssembler.getInstance().setLogger(logManager.logger('anochat.core'));
    SessionManager.getInstance().setLogger(logManager.logger('anochat.system'));
    logManager.logger('anochat.core').info('ILogger injected into core singletons');
  } catch (err) {
    logManager.logger('anochat.core').warn('ILogger injection failed', { error: (err as Error).message });
  }


  try {
    ToolRegistry.getInstance().setProfiler(ToolProfiler.getInstance());
    logManager.logger('anochat.core').info('Repository and profiler injected');
  } catch (err) {
    logManager.logger('anochat.core').warn('Repository/profiler injection failed', { error: (err as Error).message });
  }


  try {
    const { installWsForwarding } = await import('./infra/network/WsForwardSubscriber.js');
    installWsForwarding();
    logManager.logger('anochat.core').info('WsForwardSubscriber installed');
  } catch (err) {
    logManager.logger('anochat.core').warn('WsForwardSubscriber install failed', { error: (err as Error).message });
  }

  // Start session lease manager (reaps idle sessions)
  try {
    const { SessionLeaseManager } = await import('./core/session/SessionLeaseManager.js');
    SessionLeaseManager.getInstance().start();
    logManager.logger('anochat.core').info('SessionLeaseManager started');
  } catch (err) {
    logManager.logger('anochat.core').warn('SessionLeaseManager start failed', { error: (err as Error).message });
  }

  logManager.logger('anochat.core').info('Init complete', { agentCount: registry.allAgents().length, toolCount: ToolRegistry.getInstance().allTools().length });
}


const server = http.createServer(handleRequest);
const wsServer = WsServer.getInstance();
wsServer.attach(server);

export async function startServer(): Promise<http.Server> {
  await initialize();
  const settings = SettingsManager.getInstance();
  const port = settings.get<number>('port', DEFAULT_PORT);
  const host = settings.get<string>('host', DEFAULT_HOST);

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        LogManager.getInstance().logger('anochat.core').error('Port already in use', { port });
        reject(new Error(`Port ${port} already in use`));
        return;
      }
      reject(err);
    });

    server.listen(port, host, () => {
      LogManager.getInstance().logger('anochat.core').info('Server started', {
        port, version: APP_VERSION, platform: process.platform, node: process.version,
      });
      resolve(server);
    });
  });
}

let shutdownPromise: Promise<void> | null = null;

export async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const logger = LogManager.getInstance().logger('anochat.core');
    logger.info('Server shutting down');
    await v3Scheduler?.stop();
    v3Scheduler = null;
    const { configureV3WorkToolDependencies } = await import(
      './core/tools/v3/V3WorkToolSupport.js'
    );
    configureV3WorkToolDependencies(null);
    const httpClosePromise = server.listening
      ? new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
      })
      : Promise.resolve();
    v3RealtimeBridge?.stop();
    v3RealtimeBridge = null;
    await wsServer.shutdown();

    const { InterruptController, InterruptReason } = await import(
      './core/agent/supervision/InterruptController.js'
    );
    InterruptController.getInstance().interruptAll(InterruptReason.UserStop);
    const runtime = AgentRuntime.getInstance();
    const deadline = Date.now() + 5_000;
    while (runtime.activeSessionCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const { SessionTurnRecorder } = await import('./infra/SessionTurnRecorder.js');
    await SessionTurnRecorder.drainAll();
    const { SessionStore } = await import('./core/session/SessionStore.js');
    await SessionStore.getInstance().drain();
    const { SessionLeaseManager } = await import('./core/session/SessionLeaseManager.js');
    SessionLeaseManager.getInstance().stop();
    SettingsManager.getInstance().stopWatching();
    const { ExtensionManager } = await import('./core/extensible/ExtensionManager.js');
    await ExtensionManager.getInstance().stopAll();
    const { PluginHostManager } = await import('./core/plugin-host/PluginHostManager.js');
    await PluginHostManager.getInstance().stop();
    const { ApiServer } = await import('./gateway/ApiServer.js');
    await ApiServer.getInstance().stop();
    await httpClosePromise;
    logger.info('Server shutdown complete', {
      remainingActiveSessions: runtime.activeSessionCount,
    });
  })();
  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}
