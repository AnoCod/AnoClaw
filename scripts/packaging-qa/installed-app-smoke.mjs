#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import {
  assertDisposablePackagedRuntimeRoot,
  assertPathInside,
  containsAnoClawUninstallEntry,
  expectedReleaseArtifactNames,
  findAvailablePort,
  findSensitiveValuePaths,
  waitUntil,
} from './qualification-lib.mjs';

const TEST_API_KEY = 'release-qualification-placeholder';
const TEST_MODEL = 'release-smoke-model';
const TEST_AGENT_NAME = 'Release Qualification Agent';
const TEST_WORKSPACE_CONTENT = 'AnoClaw packaged-app persistence verified.\n';
const DEFAULT_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const options = {
    app: '',
    installer: '',
    output: '.artifacts/release-qualification',
    allowLocalInstaller: false,
    keepTemp: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--app') options.app = argv[++index];
    else if (arg === '--installer') options.installer = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--allow-local-installer') options.allowLocalInstaller = true;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.app && options.installer) throw new Error('Use either --app or --installer, not both');
  return options;
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const append = (target, chunk) => `${target}${chunk}`.slice(-16_000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || (options.acceptCodes || []).includes(code)) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

async function hasExistingAnoClawInstallation() {
  const uninstallRoots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];

  for (const registryRoot of uninstallRoots) {
    const result = await runProcess(
      'reg.exe',
      ['query', registryRoot, '/s', '/v', 'DisplayName'],
      { timeoutMs: 30_000, acceptCodes: [1] },
    );
    if (containsAnoClawUninstallEntry(result.stdout)) return true;
  }
  return false;
}

async function startMockLlm() {
  const requests = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy(new Error('mock request too large'));
    });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      requests.push({
        model: parsed.model,
        authorized: req.headers.authorization === `Bearer ${TEST_API_KEY}`,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-release-smoke',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: TEST_MODEL,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'RELEASE_SMOKE_OK', reasoning_content: '' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function installNsis(installerPath, installDir) {
  await fsp.mkdir(path.dirname(installDir), { recursive: true });
  await runProcess(installerPath, ['/S', `/D=${installDir}`], { timeoutMs: 180_000 });
  const appExe = path.join(installDir, 'AnoClaw.exe');
  await waitUntil(() => fs.existsSync(appExe), {
    timeoutMs: 30_000,
    label: 'silently installed AnoClaw.exe',
  });
  return appExe;
}

async function uninstallNsis(installDir) {
  const uninstaller = path.join(installDir, 'Uninstall AnoClaw.exe');
  if (!fs.existsSync(uninstaller)) return;
  try {
    await runProcess(uninstaller, ['/S'], { timeoutMs: 120_000 });
  } catch (error) {
    console.warn(`[release-smoke] silent uninstall warning: ${error.message}`);
  }
}

async function cleanPackagedRuntime(runtimeRoot, repoRoot) {
  const safeRoot = assertDisposablePackagedRuntimeRoot(runtimeRoot, repoRoot);
  for (const name of ['config', 'data', 'logs', 'memory', 'workspace', 'lancedb']) {
    const candidate = assertPathInside(path.join(safeRoot, name), safeRoot, `runtime ${name}`);
    await fsp.rm(candidate, { recursive: true, force: true });
  }
  const pluginsRoot = path.join(safeRoot, 'plugins');
  if (fs.existsSync(pluginsRoot)) {
    for (const plugin of await fsp.readdir(pluginsRoot, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      for (const name of ['data', 'logs', 'tmp', 'cache']) {
        const candidate = assertPathInside(path.join(pluginsRoot, plugin.name, name), pluginsRoot, 'plugin runtime path');
        await fsp.rm(candidate, { recursive: true, force: true });
      }
    }
  }
}

async function prepareRuntimeConfig(runtimeRoot, uiPort, apiPort) {
  const configDir = path.join(runtimeRoot, 'config');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(path.join(configDir, 'settings.yaml'), [
    `port: ${uiPort}`,
    'host: 127.0.0.1',
    `apiPort: ${apiPort}`,
    'logging:',
    '  level: warn',
    '',
  ].join('\n'), 'utf8');
}

async function waitForCdp(port, child) {
  await waitUntil(async () => {
    if (child.exitCode != null) throw new Error(`AnoClaw exited early with code ${child.exitCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, label: `Electron CDP on ${port}` });
}

async function launchApp(appExe, userDataDir, cdpPort) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ANOCLAW_CDP_PORT = String(cdpPort);
  env.ANOCLAW_GPU_MODE = 'software';
  env.ANOCHAT_ENCRYPTION_KEY = 'release-qualification-encryption-placeholder';
  const child = spawn(appExe, [`--user-data-dir=${userDataDir}`], {
    cwd: path.dirname(appExe),
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForCdp(cdpPort, child);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const context = await waitUntil(() => browser.contexts()[0], {
    timeoutMs: 10_000,
    label: 'Electron browser context',
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  return { child, browser, context, cdpPort };
}

async function stopApp(launch) {
  if (!launch) return;
  try {
    await Promise.race([
      launch.browser.close(),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch {}
  if (launch.child.exitCode == null && launch.child.pid) {
    try {
      await runProcess('taskkill.exe', ['/PID', String(launch.child.pid), '/T', '/F'], {
        timeoutMs: 20_000,
        acceptCodes: [128],
      });
    } catch (error) {
      if (launch.child.exitCode == null) throw error;
    }
  }
  await waitUntil(() => launch.child.exitCode != null, {
    timeoutMs: 10_000,
    label: 'AnoClaw process exit',
  }).catch(() => undefined);
}

async function waitForPage(context, predicate, label) {
  return await waitUntil(() => context.pages().find(predicate), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    label,
  });
}

async function waitForMainPage(context, uiPort) {
  const page = await waitForPage(
    context,
    (candidate) => {
      try {
        const url = new URL(candidate.url());
        return url.protocol === 'http:'
          && ['localhost', '127.0.0.1'].includes(url.hostname)
          && Number(url.port) === uiPort;
      } catch {
        return false;
      }
    },
    'AnoClaw main window',
  );
  await page.waitForSelector('.topbar-cinema');
  await page.waitForFunction(() => Boolean(window.__anoclawApp?.sseClient?.connected));
  return page;
}

async function completeSetup(context, mockPort) {
  const setup = await waitForPage(
    context,
    (candidate) => candidate.url().startsWith('file:') && candidate.url().includes('setup-wizard'),
    'first-run setup window',
  );
  await setup.locator('#agentName').fill(TEST_AGENT_NAME);
  await setup.locator('#provider').selectOption('openai-compatible');
  await setup.locator('#model').fill(TEST_MODEL);
  await setup.locator('#apiUrl').fill(`http://127.0.0.1:${mockPort}`);
  await setup.locator('#apiKey').fill(TEST_API_KEY);
  await setup.locator('#contextWindow').selectOption('128000');
  await setup.locator('#btnTest').click();
  await setup.locator('#status').filter({ hasText: 'Setup complete' }).waitFor();
  return setup;
}

async function apiRequest(apiPort, pathname, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, body, text };
}

async function waitForApiHealth(apiPort) {
  return await waitUntil(async () => {
    const response = await apiRequest(apiPort, '/api/v1/health', { timeoutMs: 1500 });
    return response.status === 200 ? response : null;
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, label: `AnoClaw API health on ${apiPort}` });
}

async function readAdminToken(runtimeRoot) {
  const apiPath = path.join(runtimeRoot, 'config', 'api.json');
  return await waitUntil(async () => {
    try {
      const parsed = JSON.parse(await fsp.readFile(apiPath, 'utf8'));
      const token = parsed.tokens?.find((candidate) => typeof candidate?.token === 'string')?.token;
      return token || null;
    } catch {
      return null;
    }
  }, { timeoutMs: 15_000, label: 'persisted administrator token' });
}

async function verifyApiContract(apiPort, runtimeRoot) {
  const health = await waitForApiHealth(apiPort);
  assert.equal(health.status, 200);
  const unauthorized = await apiRequest(apiPort, '/api/v1/settings');
  assert.equal(unauthorized.status, 401, 'settings must reject missing authentication');
  const token = await readAdminToken(runtimeRoot);
  const settings = await apiRequest(apiPort, '/api/v1/settings', { token });
  assert.equal(settings.status, 200, 'authenticated settings request must succeed');
  assert.equal(settings.text.includes(TEST_API_KEY), false, 'settings response exposed the setup API key');
  assert.deepEqual(findSensitiveValuePaths(settings.body), [], 'settings response exposed a sensitive value');
  return token;
}

async function verifyPluginPages(page, outputDir, suffix) {
  await page.evaluate(() => window.__anoclawApp?.navigateTo('gateway'));
  const gatewayIframe = await page.waitForSelector('.plugin-page-container[data-plugin="anoclaw-gateway"] iframe');
  const gatewayFrame = await waitUntil(() => gatewayIframe.contentFrame(), {
    timeoutMs: 15_000,
    label: 'Gateway plugin iframe',
  });
  await gatewayFrame.waitForFunction(() => Boolean(window._gwPage?._wsConnected));
  await page.screenshot({ path: path.join(outputDir, `gateway-${suffix}.png`), fullPage: true });

  const mcpNetwork = [];
  const recordRequest = (request) => {
    if (request.url().includes('/api/mcp/')) mcpNetwork.push({ event: 'request', url: request.url() });
  };
  const recordResponse = (response) => {
    if (response.url().includes('/api/mcp/')) {
      const entry = { event: 'response', url: response.url(), status: response.status(), body: '' };
      mcpNetwork.push(entry);
      void response.text()
        .then((body) => { entry.body = body.slice(0, 500); })
        .catch(() => undefined);
    }
  };
  const recordFailure = (request) => {
    if (request.url().includes('/api/mcp/')) {
      mcpNetwork.push({ event: 'requestfailed', url: request.url(), error: request.failure()?.errorText || '' });
    }
  };
  page.on('request', recordRequest);
  page.on('response', recordResponse);
  page.on('requestfailed', recordFailure);
  await page.evaluate(() => window.__anoclawApp?.navigateTo('mcp'));
  const mcpIframe = await page.waitForSelector('.plugin-page-container[data-plugin="anoclaw-mcp"] iframe');
  const mcpFrame = await waitUntil(() => mcpIframe.contentFrame(), {
    timeoutMs: 15_000,
    label: 'MCP plugin iframe',
  });
  try {
    await mcpFrame.waitForFunction(
      () => Boolean(window._mcpPage && window._mcpPage._loading === false),
      undefined,
      { timeout: 20_000 },
    );
    await mcpFrame.waitForFunction(
      () => Boolean(window._mcpPage?._ws?.readyState === WebSocket.OPEN),
      undefined,
      { timeout: 20_000 },
    );
    await page.screenshot({ path: path.join(outputDir, `mcp-${suffix}.png`), fullPage: true });
  } catch (error) {
    const state = await mcpFrame.evaluate(() => ({
      href: window.location.href,
      baseURI: document.baseURI,
      referrer: document.referrer,
      loading: window._mcpPage?._loading,
      wsReadyState: window._mcpPage?._ws?.readyState ?? null,
      scripts: Array.from(document.scripts).map((script) => script.src).filter(Boolean),
    })).catch(() => ({ unavailable: true }));
    throw new Error(`MCP plugin readiness failed: ${JSON.stringify({ state, network: mcpNetwork.slice(-20) })}; ${error.message}`);
  } finally {
    page.off('request', recordRequest);
    page.off('response', recordResponse);
    page.off('requestfailed', recordFailure);
  }
}

async function createPersistentFixture(apiPort, token, workspaceRoot) {
  await fsp.mkdir(workspaceRoot, { recursive: true });
  const created = await apiRequest(apiPort, '/api/v1/sessions', {
    method: 'POST',
    token,
    body: { agentId: 'main-agent', title: 'Release qualification session' },
  });
  assert.equal(created.status, 201, 'session creation failed');
  const sessionId = created.body?.id;
  assert.equal(typeof sessionId, 'string');

  const bound = await apiRequest(apiPort, `/api/v1/sessions/${encodeURIComponent(sessionId)}/bind-workspace`, {
    method: 'PATCH',
    token,
    body: { path: workspaceRoot },
  });
  assert.equal(bound.status, 200, 'workspace binding failed');
  const written = await apiRequest(apiPort, '/api/v1/workspace/write', {
    method: 'PUT',
    token,
    body: { sessionId, path: 'release-smoke.txt', content: TEST_WORKSPACE_CONTENT },
  });
  assert.equal(written.status, 200, 'workspace write failed');
  const read = await apiRequest(
    apiPort,
    `/api/v1/workspace/read?sessionId=${encodeURIComponent(sessionId)}&path=release-smoke.txt`,
    { token },
  );
  assert.equal(read.status, 200);
  assert.equal(read.body?.content, TEST_WORKSPACE_CONTENT);
  return sessionId;
}

async function verifyPersistentFixture(apiPort, token, sessionId) {
  const sessions = await apiRequest(apiPort, '/api/v1/sessions', { token });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body?.sessions?.some((session) => session.id === sessionId), true, 'session did not persist');
  const read = await apiRequest(
    apiPort,
    `/api/v1/workspace/read?sessionId=${encodeURIComponent(sessionId)}&path=release-smoke.txt`,
    { token },
  );
  assert.equal(read.status, 200);
  assert.equal(read.body?.content, TEST_WORKSPACE_CONTENT, 'workspace file did not persist');
}

async function captureFailureScreenshots(launch, outputDir) {
  if (!launch?.context) return;
  let index = 0;
  for (const page of launch.context.pages()) {
    try {
      await page.screenshot({ path: path.join(outputDir, `failure-${index++}.png`), fullPage: true });
    } catch {}
  }
}

function sanitizedError(error, redactions = []) {
  let message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  for (const value of [TEST_API_KEY, ...redactions].filter(Boolean)) {
    message = message.split(String(value)).join('<redacted>');
  }
  return message.replace(/sk-[A-Za-z0-9_-]{20,}/g, '<redacted-key>');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Packaged-app smoke tests require Windows');
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/packaging-qa/installed-app-smoke.mjs [--app path | --installer path] [--output dir]');
    return;
  }

  const repoRoot = process.cwd();
  const packageJson = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const names = expectedReleaseArtifactNames(packageJson.version);
  if (options.installer === 'auto') options.installer = path.join('release9', names.installer);
  if (!options.app && !options.installer) {
    options.app = path.join('release9', 'win-unpacked', 'AnoClaw.exe');
  }
  if (options.installer && process.env.CI !== 'true' && !options.allowLocalInstaller) {
    throw new Error('NSIS installation mode is restricted to CI; use --app locally or pass --allow-local-installer explicitly');
  }
  if (options.installer && await hasExistingAnoClawInstallation()) {
    throw new Error(
      'Existing AnoClaw installation detected; refusing isolated NSIS qualification because the installer may upgrade it even when /D targets a temporary directory. Run this mode on a clean Windows host.',
    );
  }

  const outputDir = path.resolve(repoRoot, options.output);
  assertPathInside(outputDir, repoRoot, 'release qualification output');
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-release-smoke-'));
  const summary = {
    ok: false,
    mode: options.installer ? 'nsis-installed' : 'packaged',
    version: packageJson.version,
    expectedArtifacts: names,
    startedAt: new Date().toISOString(),
    checks: [],
  };
  let appExe;
  let runtimeRoot;
  let installDir = '';
  let activeLaunch = null;
  let mock = null;
  let adminToken = '';

  const check = async (name, operation) => {
    const startedAt = Date.now();
    const value = await operation();
    summary.checks.push({ name, durationMs: Date.now() - startedAt, ok: true });
    return value;
  };

  try {
    if (options.installer) {
      const installerPath = path.resolve(repoRoot, options.installer);
      assertPathInside(installerPath, repoRoot, 'installer path');
      assert.equal(path.basename(installerPath), names.installer, 'unexpected installer artifact name');
      installDir = path.join(tempRoot, 'installed');
      appExe = await check('silent NSIS install', () => installNsis(installerPath, installDir));
      runtimeRoot = path.join(installDir, 'resources', 'app.asar.unpacked');
    } else {
      appExe = path.resolve(repoRoot, options.app);
      assert.equal(fs.existsSync(appExe), true, `packaged app is missing: ${appExe}`);
      runtimeRoot = path.join(path.dirname(appExe), 'resources', 'app.asar.unpacked');
      await cleanPackagedRuntime(runtimeRoot, repoRoot);
    }

    const reservedPorts = new Set();
    while (reservedPorts.size < 3) reservedPorts.add(await findAvailablePort());
    const [uiPort, apiPort, cdpPort] = [...reservedPorts];
    await prepareRuntimeConfig(runtimeRoot, uiPort, apiPort);
    mock = await startMockLlm();
    const userDataDir = path.join(tempRoot, 'electron-user-data');
    const workspaceRoot = path.join(tempRoot, 'workspace');

    activeLaunch = await check('first packaged-app launch', () => launchApp(appExe, userDataDir, cdpPort));
    await activeLaunch.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const setup = await check('first-run setup with local mock LLM', () => completeSetup(activeLaunch.context, mock.port));
    await setup.screenshot({ path: path.join(outputDir, 'setup-complete.png'), fullPage: true }).catch(() => undefined);
    const mainPage = await check('main UI and global WebSocket readiness', () => waitForMainPage(activeLaunch.context, uiPort));
    assert.equal(mock.requests.some((request) => request.model === TEST_MODEL && request.authorized), true);
    adminToken = await check('external API authentication contract', () => verifyApiContract(apiPort, runtimeRoot));
    const sessionId = await check('session and workspace persistence fixture', () => (
      createPersistentFixture(apiPort, adminToken, workspaceRoot)
    ));
    await check('Gateway and MCP packaged plugin connectivity', () => verifyPluginPages(mainPage, outputDir, 'first-launch'));
    await activeLaunch.context.tracing.stop({ path: path.join(outputDir, 'first-launch-trace.zip') });
    await stopApp(activeLaunch);
    activeLaunch = null;

    activeLaunch = await check('restart without setup re-entry', () => launchApp(appExe, userDataDir, cdpPort));
    await activeLaunch.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const restartedMain = await check('restarted UI and WebSocket readiness', () => waitForMainPage(activeLaunch.context, uiPort));
    assert.equal(activeLaunch.context.pages().some((page) => page.url().includes('setup-wizard')), false, 'setup wizard reappeared after restart');
    await check('persisted session and workspace after restart', () => (
      verifyPersistentFixture(apiPort, adminToken, sessionId)
    ));
    await check('Gateway and MCP connectivity after restart', () => verifyPluginPages(restartedMain, outputDir, 'restart'));
    await activeLaunch.context.tracing.stop({ path: path.join(outputDir, 'restart-trace.zip') });
    await stopApp(activeLaunch);
    activeLaunch = null;

    assert.equal(await fsp.readFile(path.join(workspaceRoot, 'release-smoke.txt'), 'utf8'), TEST_WORKSPACE_CONTENT);
    summary.ok = true;
    summary.completedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await captureFailureScreenshots(activeLaunch, outputDir);
    summary.error = sanitizedError(error, [adminToken, tempRoot]);
    summary.completedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    await stopApp(activeLaunch).catch((error) => console.warn(`[release-smoke] cleanup warning: ${error.message}`));
    if (mock) await mock.close().catch(() => undefined);
    if (options.installer && installDir) await uninstallNsis(installDir);
    if (!options.installer && runtimeRoot) {
      await cleanPackagedRuntime(runtimeRoot, repoRoot).catch((error) => {
        console.warn(`[release-smoke] packaged runtime cleanup warning: ${error.message}`);
      });
    }
    if (!options.keepTemp) await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[release-smoke] ${sanitizedError(error)}`);
  process.exitCode = 1;
});
