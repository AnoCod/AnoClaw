// ToolHandlers — tool list, direct execution, command list
// Extracted from ApiServer.ts to keep the class under 500 lines.

import * as http from 'http';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { CommandRegistry } from '../../core/commands/CommandRegistry.js';

export function handleListTools(
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
): void {
  const registry = ToolRegistry.getInstance();
  const tools = registry.allToolsWithMeta();
  const groups = registry.groups();
  sendJson(res, 200, { tools, groups, total: tools.length });
}

export function handleListCommands(
  res: http.ServerResponse,
  sendJson: (res: http.ServerResponse, code: number, data: Record<string, unknown>) => void,
): void {
  const registry = CommandRegistry.getInstance();
  const commands = registry.allCommandDefinitions();
  sendJson(res, 200, { commands, total: commands.length });
}
