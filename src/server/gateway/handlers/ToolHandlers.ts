// ToolHandlers — tool list, direct execution, command list
// Extracted from ApiServer.ts to keep the class under 500 lines.

import * as http from 'http';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { CommandRegistry } from '../../core/commands/CommandRegistry.js';
import type { SendJson } from '../RouteHelpers.js';

/**
 * GET /api/v1/tools — List all registered tools with metadata and categories.
 * Returns an array of tool descriptors with names, descriptions, schemas, and group info.
 */
export function handleListTools(
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const registry = ToolRegistry.getInstance();
  const tools = registry.allToolsWithMeta();
  const groups = registry.groups();
  sendJson(res, 200, { tools, groups, total: tools.length });
}

/**
 * GET /api/v1/commands — List all registered slash commands with definitions.
 */
export function handleListCommands(
  res: http.ServerResponse,
  sendJson: SendJson,
): void {
  const registry = CommandRegistry.getInstance();
  const commands = registry.allCommandDefinitions();
  sendJson(res, 200, { commands, total: commands.length });
}
