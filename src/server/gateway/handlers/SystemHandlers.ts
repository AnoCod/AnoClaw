// SystemHandlers — health, stats, logs, open-file
// Extracted from ApiServer.ts to keep the class under 500 lines.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { APP_NAME, APP_VERSION } from '../../../shared/constants.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { LogManager } from '../../infra/logging/LogManager.js';

export function handleHealth(
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
): void {
  sendJson(res, 200, {
    status: 'ok',
    app: APP_NAME,
    version: APP_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

export function handleStats(
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
): void {
  const runtime = AgentRuntime.getInstance();
  const registry = AgentRegistry.getInstance();
  const sessionManager = SessionManager.getInstance();

  sendJson(res, 200, {
    agents: { total: registry.size, active: registry.activeAgents().length },
    sessions: { total: sessionManager.listSessions().length, active: sessionManager.activeSessions().length },
    runtime: { activeLoops: runtime.activeSessionCount },
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

export function handleGetLogEntries(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
  host: string,
  port: number,
): void {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const count = parseInt(url.searchParams.get('count') || '200', 10);
  const category = url.searchParams.get('category') || '';
  const logManager = LogManager.getInstance();
  const entries = category
    ? logManager.recentEntries(category, count)
    : logManager.search('', count);
  sendJson(res, 200, { entries } as unknown as Record<string, unknown>);
}

export async function handleOpenFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const body = await readBody(req);
    const filePath = body.path as string;
    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" field' });
      return;
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      sendJson(res, 404, { error: 'Not Found', message: `Path not found: ${filePath}` });
      return;
    }

    const platform = process.platform;

    if (platform === 'win32') {
      const winPath = resolved.replace(/\//g, '\\');
      exec(`explorer /select,"${winPath}"`, () => {});
      sendJson(res, 200, { path: resolved, opened: true });
      return;
    }

    const command = platform === 'darwin'
      ? `open -R "${resolved}"`
      : `xdg-open "${fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)}"`;

    exec(command, (error) => {
      if (error) {
        sendJson(res, 500, { error: 'Failed to open file', message: error.message });
      } else {
        sendJson(res, 200, { path: resolved, opened: true });
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Open file failed', message });
  }
}
