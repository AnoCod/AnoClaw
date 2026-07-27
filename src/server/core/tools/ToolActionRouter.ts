import type { ExecutionContext, Tool, ToolResult } from './Tool.js';
import { ToolPipeline } from './ToolPipeline.js';
import { makeError } from './ToolResult.js';

export interface ToolActionDefinition {
  description: string;
  tool: Tool;
}

export type ToolActionMap = Record<string, ToolActionDefinition>;

interface ObjectSchema {
  properties?: Record<string, Record<string, unknown>>;
}

export function buildActionSchema(actions: ToolActionMap): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {
    action: {
      type: 'string',
      enum: Object.keys(actions),
      description: Object.entries(actions)
        .map(([name, definition]) => `${name}: ${definition.description}`)
        .join(' '),
    },
  };

  for (const definition of Object.values(actions)) {
    const schema = definition.tool.parametersSchema() as ObjectSchema;
    Object.assign(properties, schema.properties || {});
  }

  return {
    type: 'object',
    properties,
    required: ['action'],
    additionalProperties: false,
  };
}

export function getToolAction(
  actions: ToolActionMap,
  params: Record<string, unknown>,
): ToolActionDefinition | undefined {
  return typeof params.action === 'string' ? actions[params.action] : undefined;
}

export function withoutAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...actionParams } = params;
  return actionParams;
}

export async function executeToolAction(
  actions: ToolActionMap,
  params: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const definition = getToolAction(actions, params);
  if (!definition) return makeError(`Unknown action: ${String(params.action || '')}`);

  const actionParams = withoutAction(params);
  const validationError = ToolPipeline.validateParams(definition.tool, actionParams);
  if (validationError) return validationError;
  return definition.tool.execute(actionParams, ctx);
}
