// RestartServerTool - graceful server restart with session checkpoint.
// Writes checkpoint to disk, then uses Electron's app.relaunch() + app.quit()
// for reliable restart. The frontend sees the restart via WS close code 1012.

import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { createLogger } from '../../logger.js';

const CHECKPOINT_FILE = 'data/restart-checkpoint.json';
const log = createLogger('anochat.tool');

export class RestartServerTool extends Tool {

  static category = 'System';
  static toolDescription = 'Gracefully restart the AnoClaw server and resume the current session.';

  name(): string {
    return 'RestartServer';
  }

  description(): string {
    return 'Restart the AnoClaw application gracefully. Writes a checkpoint so the current session resumes automatically after restart.';
  }

  prompt(): string {
    return '## RestartServer Usage\n' +
      'Gracefully restart the application. A checkpoint is written to disk - your session resumes exactly where it left off after restart.\n\n' +
      '**When to use:** After modifying server source code (src/server/) that needs recompilation. After installing new npm packages.\n\n' +
      '**When NOT to use:** Plugin changes (auto-reload via file watcher). Frontend changes (just rebuild, no restart needed). Any change that doesn\'t touch server code.\n\n' +
      'The `resumeMessage` parameter is shown to you after restart - include what you were working on and your next step.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        resumeMessage: {
          type: 'string',
          description: 'Message to yourself after restart - what you were doing and what to do next.',
        },
      },
      required: ['resumeMessage'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Critical;
  }

  isReadOnly(): boolean {
    return false;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  defaultTimeoutMs(): number {
    return 5000;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const resumeMessage = params.resumeMessage as string;
    if (!resumeMessage || typeof resumeMessage !== 'string') {
      return this.makeError('resumeMessage is required');
    }

    const checkpoint = {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      resumeMessage,
      timestamp: Date.now(),
    };

    const filePath = path.resolve(process.cwd(), CHECKPOINT_FILE);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    } catch (err) {
      return this.makeError(`Failed to write checkpoint: ${(err as Error).message}`);
    }

    // Register with BackgroundTaskManager so AgentLoop enters event-driven wait
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = bgm.register({
      type: 'command',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: 'Server restart',
    });
    log.info('RestartServer: registered background task', { taskId, sessionId: ctx.sessionId });

    // Close all WebSocket connections with code 1012 (Service Restart).
    // Frontend detects this close code and does location.reload() to
    // pick up new JS/CSS before reconnecting.
    const { WsServer } = await import('../../../infra/network/WsServer.js');
    WsServer.getInstance().shutdownAll();

    // Schedule restart after the tool result has been flushed to the frontend.
    // setImmediate ensures we're past the current tool pipeline + WS send cycle.
    // Electron's app.quit() is graceful - it fires before-quit -> windows close -> exit.
    setImmediate(async () => {
      try {
        const electron = await import('electron');
        electron.app.relaunch();
        electron.app.quit();
      } catch {
        // Fallback: if electron import fails (dev without Electron), just exit
        process.exit(0);
      }
    });

    return this.makeResult(
      `Server restarting. Will resume session ${ctx.sessionId} after restart.\nResume: "${resumeMessage}"`,
    );
  }
}
