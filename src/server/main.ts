// AnoClaw v2.0 — Main entry point
// HTTP + WebSocket server: serves API, static files, real-time agent communication

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DEFAULT_HOST, APP_NAME, APP_VERSION, DEFAULT_MAIN_AGENT_ID } from '../shared/constants.js';
import { WsServer } from './infra/network/WsServer.js';
import { WsMessageRouter } from './infra/network/WsMessageRouter.js';
import { registerAllWsHandlers } from './infra/network/handlers/registerAllHandlers.js';
import { AgentRegistry } from './core/agent/AgentRegistry.js';
import { loadAgentConfig } from './core/agent/AgentConfig.js';
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

// Static files (src/public/) are INSIDE the asar — use __dirname-based path.
// process.cwd() is the unpacked root (or project root in dev) and won't find these.
const PUBLIC_DIR = appPath('src', 'public');

// ── CORS helper ──
function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── HTTP request handler ──
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
  setCors(res);
  const url = req.url || '/';

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
  // DELETE /api/v1/plugins/:name — uninstall a plugin
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
      // Move to .disabled instead of deleting (recoverable)
      const disabledDir = writablePath('plugins', `${name}.disabled`);
      if (fs.existsSync(disabledDir)) fs.rmSync(disabledDir, { recursive: true, force: true });
      fs.renameSync(pluginDir, disabledDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, status: 'uninstalled', recoverable: true }));
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
        const destName = body.name as string || `plugin-${Date.now().toString(36)}`;
        const destDir = writablePath('plugins', destName);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        // GitHub repo install: convert github.com/owner/repo to raw URLs
        const githubMatch = installUrl.match(/github\.com\/([^\/]+)\/([^\/\s#]+)/);
        if (githubMatch) {
          const [, owner, repoSlug] = githubMatch;
          const repo = repoSlug.replace(/\.git$/, '');
          const branch = body.branch as string || 'main';
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
            } catch { /* file may not exist — skip */ }
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
          const fullPath = path.join(destDir, filePath);
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

  // Skills list endpoint — GET list + POST import (standard SKILL.md format)
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
    // GET — list skills (nested dir/SKILL.md standard + deprecated flat .md fallback)
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

  // Skills PATCH — enable/disable a skill (handles both nested and flat)
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

  // API passthrough — delegate to ApiServer
  if (url.startsWith('/api/')) {
    const { ApiServer } = await import('./gateway/ApiServer.js');
    await ApiServer.getInstance().handleApiRequest(req, res);
    return;
  }

  // Reject non-upgrade HTTP requests to WebSocket path — upgrades are handled by WsServer
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

// ── Startup initialization ──
async function initialize(): Promise<void> {
  // 1. Initialize logging
  const logManager = LogManager.getInstance();
  logManager.initialize('logs');

  // 1.5 Load settings from config/settings.yaml (merged with defaults)
  const settings = SettingsManager.getInstance();
  await settings.load();

  // 2. Load agents from data/agents/ — create MainAgent on first run
  const registry = AgentRegistry.getInstance();
  const agentsDir = ensureWritableDir('data', 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const agentId = file.replace('.json', '');
    try {
      const config = await loadAgentConfig(agentId);
      const { Agent } = await import('./core/agent/Agent.js');
      const agent = new Agent(config);
      registry.registerAgent(agent);
      logManager.logger('anochat.core').info('Agent loaded', { aid: agent.id, name: agent.name });
    } catch (err) {
      logManager.logger('anochat.core').warn('Agent load failed', { aid: agentId, error: (err as Error).message });
    }
  }

  // Auto-create a main agent on first run only if setup is done (apiKey exists).
  // If settings.yaml has no apiKey, the setup wizard hasn't run yet — skip creation.
  if (registry.allAgents().length === 0) {
    const hasApiKey = !!settings.get('apiKey');
    if (!hasApiKey) {
      logManager.logger('anochat.core').info('No agents and no apiKey — skipping auto-create, waiting for setup wizard');
    } else {
      logManager.logger('anochat.core').info('First run — creating default MainAgent');
      const { Agent } = await import('./core/agent/Agent.js');
      const { defaultConfig, saveAgentConfig } = await import('./core/agent/AgentConfig.js');
      const defaultId = DEFAULT_MAIN_AGENT_ID;
      const existingCfg = await loadAgentConfig(defaultId).catch(() => null);
      if (!existingCfg) {
        const cfg = defaultConfig({
          id: defaultId,
          name: 'MainAgent',
          role: 'MainAgent' as import('../shared/types/agent.js').AgentRole,
          level: 0,
          teamName: 'Executive',
          provider: settings.get('provider') || 'openai-compatible',
          apiUrl: settings.get('apiUrl') || '',
          apiKey: settings.get('apiKey') || '',
          model: settings.get('model') || '',
          contextWindow: Number(settings.get('contextWindow')) || 131072,
          allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
          enabledSkills: [],
        } as Partial<import('../shared/types/agent.js').AgentConfig>);
        await saveAgentConfig(cfg);
        const agent = new Agent(cfg);
        registry.registerAgent(agent);
        logManager.logger('anochat.core').info('MainAgent auto-created', { aid: agent.id, name: agent.name });
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

  // 4. Initialize SessionManager
  const sessionManager = SessionManager.getInstance();
  try {
    await sessionManager.initialize(ensureWritableDir('data', 'sessions'));
    logManager.logger('anochat.core').info('SessionManager initialized');
  } catch (err) {
    logManager.logger('anochat.core').warn('SessionManager init skipped', { error: (err as Error).message });
  }

  // 4.5 Initialize API auth tokens
  await initAuthStore('config');

  // 4.6 Restart checkpoint recovery — inject system message into JSONL on startup.
  // Don't try to wake the agent directly (AgentLoop needs agent registry, session cache,
  // and WS connection all ready). Instead, inject a system message into the session's
  // JSONL. When the user sends their first message after restart, the agent naturally
  // sees it in history and resumes where it left off.
  try {
    const checkpointPath = writablePath('data', 'restart-checkpoint.json');
    if (fs.existsSync(checkpointPath)) {
      const raw = fs.readFileSync(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(raw);
      const age = Date.now() - (checkpoint.timestamp || 0);
      const MAX_AGE = 5 * 60 * 1000; // 5 minutes
      if (age < MAX_AGE && checkpoint.sessionId && checkpoint.resumeMessage) {
        const { SessionStore } = await import('./core/session/SessionStore.js');
        const store = SessionStore.getInstance();
        // Check if session EXISTS ON DISK — in-memory SessionManager is empty on startup.
        const sessDir = path.join(store.getSessionsDir(), checkpoint.sessionId);
        if (fs.existsSync(sessDir)) {
          // Inject system message directly into JSONL — SessionManager isn't loaded yet.
          const now = new Date().toISOString();
          const evId = () => `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await store.persistEvent(checkpoint.sessionId, {
            type: 'user',
            uuid: evId(),
            sessionId: checkpoint.sessionId,
            message: {
              role: 'user',
              content: [{ type: 'text', text: `[Server restarted]\n\nBefore restart I was working on:\n${checkpoint.resumeMessage}\n\nNow continuing.` }],
            },
            timestamp: now,
            agentId: 'system',
          });
          logManager.logger('anochat.core').info('Restart checkpoint injected into session JSONL', {
            sid: checkpoint.sessionId, ageMs: age,
          });
          // Only delete checkpoint after successful injection
          fs.unlinkSync(checkpointPath);
        } else {
          logManager.logger('anochat.core').warn('Restart checkpoint skipped — session not found on disk', {
            sid: checkpoint.sessionId, ageMs: age,
          });
          fs.unlinkSync(checkpointPath);
        }
      } else {
        // Expired or invalid — clean up
        fs.unlinkSync(checkpointPath);
      }
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

  // 11. Register and start Extensions — gated by plugin existence
  try {
    const { ExtensionManager } = await import('./core/extensible/ExtensionManager.js');
    const extMgr = ExtensionManager.getInstance();

    // Kernel subsystems (always start — not optional)
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

  // ── Dependency Injection: inject ILogger into core singletons ──
  try {
    AgentRegistry.getInstance().setLogger(logManager.logger('anochat.agent'));
    ToolRegistry.getInstance().setLogger(logManager.logger('anochat.tools'));
    PromptAssembler.getInstance().setLogger(logManager.logger('anochat.core'));
    SessionManager.getInstance().setLogger(logManager.logger('anochat.system'));
    logManager.logger('anochat.core').info('ILogger injected into core singletons');
  } catch (err) {
    logManager.logger('anochat.core').warn('ILogger injection failed', { error: (err as Error).message });
  }

  // ── Dependency Injection: wire profiler into core singletons ──
  try {
    ToolRegistry.getInstance().setProfiler(ToolProfiler.getInstance());
    logManager.logger('anochat.core').info('Repository and profiler injected');
  } catch (err) {
    logManager.logger('anochat.core').warn('Repository/profiler injection failed', { error: (err as Error).message });
  }

  // Install TypedEventBus → WebSocket forwarding (bridges core events to browser)
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

// ── Server startup (exported for Electron) ──
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

export async function shutdown(): Promise<void> {
  LogManager.getInstance().logger('anochat.core').info('Server shutting down');
  await wsServer.shutdown();
  server.close();
}
