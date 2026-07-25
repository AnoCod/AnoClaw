// ToolRegistrar — auto-discovers and registers all built-in tools
// Scans the builtin/ directory for Tool subclasses at startup.
// New tools only need to be placed in the directory — no manual registration.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ToolRegistry } from '../core/tools/ToolRegistry.js';
import type { Tool } from '../core/tools/Tool.js';
import { LogManager } from '../infra/logging/LogManager.js';

const log = LogManager.getInstance().logger('anochat.tools');

/**
 * Register all built-in tools by scanning the builtin/ directory.
 * Any file exporting a Tool subclass is automatically registered.
 * Call once during server initialization.
 */
export async function registerAllTools(tools: ToolRegistry): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // Resolve to dist/server/core/tools/builtin/ at runtime
  const builtinDir = path.resolve(__dirname, '..', 'core', 'tools', 'builtin');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(builtinDir, { withFileTypes: true });
  } catch (err) {
    log.warn('Builtin tools directory not found, skipping auto-registration', { dir: builtinDir });
    return;
  }

  let registered = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    // Skip declaration files, source maps, and non-tool helpers
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js.map')) continue;
    if (entry.name === 'main.js') continue;

    const filePath = path.join(builtinDir, entry.name);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const toolInstance = extractTool(mod);
      if (toolInstance) {
        const category = (toolInstance.constructor as typeof Tool).category || 'Uncategorized';
        tools.registerTool(toolInstance, category);
        registered++;
      }
    } catch (err) {
      log.error('Failed to load tool', { file: entry.name, error: (err as Error).message });
    }
  }

  log.info(`Auto-registered ${registered} built-in tools from ${builtinDir}`);
}

/**
 * Extract a Tool instance from a module's exports.
 * Looks for the default export or the first named export that is a Tool subclass.
 */
function extractTool(mod: Record<string, unknown>): Tool | null {
  // Try default export first
  const candidates = [mod.default, ...Object.values(mod)];
  for (const candidate of candidates) {
    if (typeof candidate !== 'function') continue;
    // Check that it's a constructor that extends Tool
    try {
      const instance = new (candidate as new () => Tool)();
      if (typeof instance.name === 'function' && typeof instance.execute === 'function') {
        return instance;
      }
    } catch {
      // Not instantiable without args — skip
      continue;
    }
  }
  return null;
}
