
// HTTP + WebSocket server: serves API, static files, real-time agent communication

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DEFAULT_HOST, APP_NAME, APP_VERSION, DEFAULT_MAIN_AGENT_ID } from '../shared/constants.js';
import { WsServer } from './infra/network/WsServer.js';
import { WsMessageRouter } from './infra/network/WsMessageRouter.js';
import { registerAllWsHandlers } from './infra/network/handlers/registerAllHandlers.js';
import { AgentRegistry } from './core/agent/AgentRegistry.js';
import { AgentRuntime } from './core/agent/AgentRuntime.js';
import { loadAgentConfig, saveAgentConfig } from './core/agent/AgentConfig.js';
import { migrateCoordinationToolAllowlist } from './core/agent/DefaultAgentTemplate.js';
import { SessionManager } from './core/session/SessionManager.js';
import { recoverRestartCheckpoint } from './core/session/RestartCheckpointRecovery.js';
import { ToolRegistry } from './core/tools/ToolRegistry.js';
import { ToolProfiler } from './infra/supervision/ToolProfiler.js';
import { PromptAssembler } from './core/prompt/PromptAssembler.js';
import { CommandRegistry } from './core/commands/CommandRegistry.js';
import { LogManager } from './infra/logging/LogManager.js';
import { hasPermission, initAuthStore, validateToken } from './gateway/ApiAuth.js';
import { isTrustedUiRequest, TRUSTED_UI_HEADER } from './gateway/TrustedUiAuth.js';
import { ApiPermission } from '../shared/types/gateway.js';
import { SettingsManager } from './infra/storage/SettingsManager.js';
import { serveStatic } from './infra/StaticFiles.js';
import { writablePath, ensureWritableDir, appPath } from './infra/WritablePath.js';
import { atomicWriteFile } from './core/tools/builtin/FileUtils.js';
import { installPluginFromUrl, PluginInstallError } from './core/plugin-host/PluginInstaller.js';

// Set cwd to the unpacked root when packaged (asar is read-only).
// In dev mode, REPO_ROOT is the real project directory.
const REPO_ROOT = writablePath();
process.chdir(REPO_ROOT);


// process.cwd() is the unpacked root (or project root in dev) and won't find these.
const PUBLIC_DIR = appPath('src', 'public');


function isAllowedLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    const settings = SettingsManager.getInstance();
    const configuredUiPort = settings.get<number>('port', DEFAULT_PORT);
    const configuredApiPort = settings.get<number>('apiPort', 15730);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '::1'].includes(hostname)
      && [configuredUiPort, configuredApiPort].includes(port);
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
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${TRUSTED_UI_HEADER}`);
}

function authorizeLegacyAdminApi(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isTrustedUiRequest(req)) return true;
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match ? validateToken(match[1]) : null;
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing Bearer token' }));
    return false;
  }
  if (!hasPermission(token, ApiPermission.Admin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', message: 'Missing permission: admin' }));
    return false;
  }
  return true;
}

const LEGACY_API_BODY_LIMIT = 1024 * 1024;

class RequestBodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function readJsonRequest(req: http.IncomingMessage, limit = LEGACY_API_BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    req.once('error', reject);
    req.once('end', () => {
      if (tooLarge) {
        reject(new RequestBodyError(`Request body exceeds ${limit} bytes`, 413));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON body must be an object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new RequestBodyError(`Invalid JSON: ${(error as Error).message}`, 400));
      }
    });
  });
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

  if (
    (url.startsWith('/api/v1/plugins') || url.startsWith('/api/skills'))
    && !authorizeLegacyAdminApi(req, res)
  ) {
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
    try {
      const body = await readJsonRequest(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "name" field' }));
        return;
      }
      const { PluginHostManager: PM } = await import('./core/plugin-host/PluginHostManager.js');
      const pm = PM.getInstance();
      const action = typeof body.action === 'string' ? body.action : 'reload';
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
      const status = err instanceof RequestBodyError ? err.statusCode : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Reload failed', message: msg }));
    }
    return;
  }

  // Plugin install from URL. Sources are fully fetched and validated in a hidden
  // staging directory, then renamed into place as one filesystem transaction.
  if (url === '/api/v1/plugins/install' && req.method === 'POST') {
    try {
      const body = await readJsonRequest(req);
      const installUrl = typeof body.url === 'string' ? body.url : '';
      if (!installUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "url" field' }));
        return;
      }
      const result = await installPluginFromUrl({
        url: installUrl,
        requestedName: typeof body.name === 'string' ? body.name : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        subdir: typeof body.subdir === 'string' ? body.subdir : undefined,
        pluginsDir: writablePath('plugins'),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof RequestBodyError || err instanceof PluginInstallError
        ? err.statusCode
        : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Install failed', message: msg }));
    }
    return;
  }


  if (url === '/api/skills') {
    if (req.method === 'POST') {
      try {
        const body = await readJsonRequest(req);
        const displayName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled';
        const description = typeof body.description === 'string' ? body.description : '';
        const skillBody = typeof body.content === 'string' ? body.content : '';
        const normalizedName = displayName.replace(/[^a-z0-9_-]/gi, '_').replace(/^_+|_+$/g, '') || 'untitled';
        const frontmatter = YAML.stringify({ name: displayName, description, type: 'custom' }).trim();
        const content = `---\n${frontmatter}\n---\n\n${skillBody}`;
        const skillDir = writablePath('skills', normalizedName);
        fs.mkdirSync(skillDir, { recursive: true });
        const filePath = path.join(skillDir, 'SKILL.md');
        await atomicWriteFile(filePath, content, 'utf8');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: normalizedName, name: displayName, status: 'imported' }));
      } catch (err) {
        const status = err instanceof RequestBodyError ? err.statusCode : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Skill import failed', message: (err as Error).message }));
      }
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
    try {
      const body = await readJsonRequest(req);
      if (typeof body.enabled !== 'boolean') throw new RequestBodyError('enabled must be a boolean', 400);
      const skillsDir = writablePath('skills');
      // Try nested standard format first, then deprecated flat
      let filePath = path.join(skillsDir, skillId, 'SKILL.md');
      if (!fs.existsSync(filePath)) filePath = path.join(skillsDir, `${skillId}.md`);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (!match) throw new RequestBodyError('Skill file has no YAML frontmatter', 400);
      const frontmatter = (YAML.parse(match[1]) || {}) as Record<string, unknown>;
      frontmatter.enabled = body.enabled;
      const updated = `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${raw.slice(match[0].length)}`;
      await atomicWriteFile(filePath, updated, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: skillId, enabled: body.enabled }));
    } catch (err) {
      const status = err instanceof RequestBodyError ? err.statusCode : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }


  if (url.startsWith('/api/')) {
    const { ApiServer } = await import('./gateway/ApiServer.js');
    await ApiServer.getInstance().handleTrustedUiRequest(req, res);
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


  const registry = AgentRegistry.getInstance();
  const agentsDir = ensureWritableDir('data', 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const agentId = file.replace('.json', '');
    try {
      const loaded = await loadAgentConfig(agentId);
      const migration = migrateCoordinationToolAllowlist(loaded);
      if (migration.changed) {
        await saveAgentConfig(migration.config);
        logManager.logger('anochat.core').info('Agent coordination tools migrated', { aid: agentId });
      }
      const { Agent } = await import('./core/agent/Agent.js');
      const agent = new Agent(migration.config);
      registry.registerAgent(agent);
      logManager.logger('anochat.core').info('Agent loaded', { aid: agent.id, name: agent.name });
    } catch (err) {
      logManager.logger('anochat.core').warn('Agent load failed', { aid: agentId, error: (err as Error).message });
    }
  }

  // Auto-create a main agent on first run only if setup is done (apiKey exists).

  if (registry.allAgents().length === 0) {
    const hasApiKey = !!settings.get('llm.apiKey');
    if (!hasApiKey) {
      logManager.logger('anochat.core').info('No agents and no apiKey - skipping auto-create, waiting for setup wizard');
    } else {
      logManager.logger('anochat.core').info('First run - creating default agent organization');
      const { Agent } = await import('./core/agent/Agent.js');
      const { buildDefaultAgentConfigs } = await import('./core/agent/DefaultAgentTemplate.js');
      const defaultId = DEFAULT_MAIN_AGENT_ID;
      const existingCfg = await loadAgentConfig(defaultId).catch(() => null);
      if (!existingCfg) {
        const configs = buildDefaultAgentConfigs({
          agentName: 'MainAgent',
          provider: settings.get('llm.provider') || 'openai-compatible',
          apiUrl: settings.get('llm.apiUrl') || '',
          apiKey: settings.get('llm.apiKey') || '',
          model: settings.get('llm.model') || '',
          contextWindow: Number(settings.get('llm.contextWindow')) || 131072,
        });
        for (const cfg of configs) {
          await saveAgentConfig(cfg);
          const agent = new Agent(cfg);
          registry.registerAgent(agent);
        }
        logManager.logger('anochat.core').info('Default agent organization auto-created', {
          agents: configs.map((cfg) => cfg.id),
        });
      }
    }
  }

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

  // 3.7 Initialize the native MCP service (retired the anoclaw-mcp plugin).
  // Must run before the ecosystem bridge so imported MCP configs land in the
  // native data/mcp-servers.json store.
  try {
    const { McpManager } = await import('./infra/mcp/McpManager.js');
    await McpManager.getInstance().init();
    logManager.logger('anochat.core').info('Native MCP service initialized');
  } catch (err) {
    logManager.logger('anochat.core').warn('Native MCP init failed', { error: (err as Error).message });
  }

  // 4. Initialize SessionManager
  const sessionManager = SessionManager.getInstance();
  try {
    await sessionManager.initialize(ensureWritableDir('data', 'sessions'));
    const reconciledStatuses = await sessionManager.reconcileRuntimeStatuses();
    logManager.logger('anochat.core').info('SessionManager initialized', { reconciledStatuses });
  } catch (err) {
    logManager.logger('anochat.core').error('SessionManager initialization failed', { error: (err as Error).message });
    throw err;
  }

  // 4.2 Initialize the durable multi-agent coordination event log and scheduler.
  try {
    const { CoordinationService } = await import('./core/coordination/CoordinationService.js');
    const { CoordinationScheduler } = await import('./core/coordination/CoordinationScheduler.js');
    await CoordinationService.getInstance().initialize(ensureWritableDir('data', 'coordination'));
    const coordinationRuntime = AgentRuntime.getInstance();
    CoordinationScheduler.getInstance().start(
      (task) => coordinationRuntime.runCoordinationTask(task),
    );
    logManager.logger('anochat.core').info('CoordinationService and scheduler initialized');
  } catch (err) {
    logManager.logger('anochat.core').error('Coordination initialization failed', {
      error: (err as Error).message,
    });
    throw err;
  }

  // 4.5 Initialize API auth tokens
  await initAuthStore(ensureWritableDir('config'));


  // Restore a restart checkpoint as an idempotent system message. The restartId
  // survives a crash between transcript commit and checkpoint deletion.
  try {
    const checkpointPath = writablePath('data', 'restart-checkpoint.json');
    const result = await recoverRestartCheckpoint(checkpointPath, { sessionManager });
    if (result.status === 'recovered' || result.status === 'deduplicated') {
      logManager.logger('anochat.core').info(
        'Restart checkpoint recovered',
        result as unknown as Record<string, unknown>,
      );
    } else if (result.status === 'retained_failed') {
      logManager.logger('anochat.core').warn(
        'Restart checkpoint retained for diagnostics',
        result as unknown as Record<string, unknown>,
      );
    }
  } catch (err) {
    logManager.logger('anochat.core').warn('Restart checkpoint recovery failed', { error: (err as Error).message });
  }

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

  // 10.1 Start the ecosystem bridge (Codex / Claude Code / OpenClaw / OpenCode / Hermes)
  // Must run before PluginHost starts so imported MCP configs are already in
  // the anoclaw-mcp plugin storage when it activates.
  try {
    const { EcosystemRegistry } = await import('./core/ecosystem/EcosystemRegistry.js');
    await EcosystemRegistry.getInstance().start();
    const entryCount = EcosystemRegistry.getInstance().entries().length;
    logManager.logger('anochat.core').info('Ecosystem bridge started', { discoveredEntries: entryCount });
  } catch (err) {
    logManager.logger('anochat.core').warn('Ecosystem bridge start failed', { error: (err as Error).message });
  }

  // 10.2 Initialize TalentPoolService
  try {
    const { TalentPoolService } = await import('./core/talent-pool/TalentPoolService.js');
    await TalentPoolService.getInstance().init();
    logManager.logger('anochat.core').info('TalentPoolService initialized');
  } catch (err) {
    logManager.logger('anochat.core').warn('TalentPoolService init failed', { error: (err as Error).message });
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
    extMgr.register(new SkillsExtension());
    extMgr.register(new MemoryExtension());

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

// Wire WebSocket messages through the pluggable message router
const wsRouter = new WsMessageRouter();
registerAllWsHandlers(wsRouter);

wsServer.on('message', async (sessionId: string, msg: Record<string, unknown>) => {
  await wsRouter.dispatch({
    sessionId,
    type: msg.type as string,
    data: msg,
    ws: wsServer,
  });
});

export async function startServer(): Promise<http.Server> {
  await initialize();
  const settings = SettingsManager.getInstance();
  const port = settings.get<number>('port', DEFAULT_PORT);
  const apiPort = settings.get<number>('apiPort', 15730);
  const host = settings.get<string>('host', DEFAULT_HOST);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        LogManager.getInstance().logger('anochat.core').error('Port already in use', { port });
        reject(new Error(`Port ${port} already in use`));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      LogManager.getInstance().logger('anochat.core').info('Server started', {
        port, version: APP_VERSION, platform: process.platform, node: process.version,
      });
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  wsServer.resume();

  try {
    const { ApiServer } = await import('./gateway/ApiServer.js');
    await ApiServer.getInstance().start(apiPort, DEFAULT_HOST);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return server;
}

let shutdownPromise: Promise<void> | null = null;

export async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const logger = LogManager.getInstance().logger('anochat.core');
    logger.info('Server shutting down');
    const httpClosePromise = server.listening
      ? new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
      })
      : Promise.resolve();
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
    const { MemoryDatabase } = await import('./core/memory/storage/MemoryDatabase.js');
    await MemoryDatabase.closeInstance();
    const { SessionLeaseManager } = await import('./core/session/SessionLeaseManager.js');
    SessionLeaseManager.getInstance().stop();
    const { CoordinationScheduler } = await import('./core/coordination/CoordinationScheduler.js');
    CoordinationScheduler.getInstance().stop();
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
