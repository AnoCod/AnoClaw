/**
 * OpenCode plugin worker — imports an OpenCode plugin module in an isolated
 * worker thread and bridges tools/hooks back to the main thread.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { runOpenCodePluginModule } from './opencode-plugin-runtime.js';

interface WorkerPayload {
  pluginPath: string;
  cwd: string;
}

function post(msg: unknown): void {
  parentPort?.postMessage(msg);
}

async function main(): Promise<void> {
  const payload = workerData as WorkerPayload;
  try {
    const mod = await import(pathToFileURL(payload.pluginPath).href);
    const runtime = runOpenCodePluginModule(mod, payload.cwd);
    for (const log of runtime.logs) post({ type: 'log', level: log.level, args: log.args });

    post({
      type: 'ready',
      toolDefs: runtime.toolDefs,
      hookNames: runtime.hookNames,
    });

    let nextId = 1;
    parentPort?.on('message', async (msg) => {
      if (!msg || msg.type !== 'invoke') return;
      const id = nextId++;
      try {
        const output = await runtime.invoke(msg.name, msg.params, msg.extra);
        post({ type: 'invokeResult', id, output: output ?? '' });
      } catch (err) {
        post({ type: 'invokeResult', id, error: (err as Error).message });
      }
    });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
}

void main();
