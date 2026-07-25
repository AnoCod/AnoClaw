import * as path from 'node:path';
import type { WorkspaceLeaseRecord } from '../../../../shared/types/v3/index.js';
import type { Tool } from '../../tools/Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { CommandPolicy, type CommandNetworkPolicy, type CommandPolicyMode } from '../workspace/CommandPolicy.js';
import { normalizeWriteScope } from '../workspace/WorkspaceLeaseManager.js';

export interface V3ToolJournalHooks {
  prepare(input: {
    toolCallId: string;
    toolName: string;
    readOnly: boolean;
    writeScope: string[];
  }): Promise<string>;
  markStarted(recordId: string): Promise<void>;
  markFinished(recordId: string, result: ToolResult): Promise<void>;
  markTranscriptCommitted(toolCallId: string): Promise<void>;
}

export interface V3ToolExecutionContext {
  companyId?: string;
  teamId?: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  workspaceId?: string;
  workspaceRoot?: string;
  readOnly: boolean;
  writeScope: string[];
  fencingToken: number;
  activeLeases: WorkspaceLeaseRecord[];
  allowedTools: string[];
  commandMode?: CommandPolicyMode;
  commandNetwork?: CommandNetworkPolicy;
  journal?: V3ToolJournalHooks;
}

export type V3ToolPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

/**
 * Server-owned execution attribution for v3 Run sessions.
 *
 * Agent prompts and tool parameters cannot create or mutate this registry.
 * The scheduler registers a Run before AgentLoop starts and removes it in the
 * terminal-path finally block.
 */
export class V3ToolExecutionRegistry {
  private static instance: V3ToolExecutionRegistry | null = null;

  static getInstance(): V3ToolExecutionRegistry {
    if (!this.instance) this.instance = new V3ToolExecutionRegistry();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  private readonly contexts = new Map<string, V3ToolExecutionContext>();
  private readonly journalRecords = new Map<string, Map<string, string>>();
  private readonly commandPolicy = new CommandPolicy();

  register(context: V3ToolExecutionContext): void {
    if (context.sessionId.length === 0 || context.runId.length === 0) {
      throw new Error('v3 tool execution context requires sessionId and runId');
    }
    const existing = this.contexts.get(context.sessionId);
    if (existing && existing.runId !== context.runId) {
      throw new Error(`v3 tool execution context already registered: ${context.sessionId}`);
    }
    this.contexts.set(context.sessionId, cloneContext(context));
  }

  unregister(sessionId: string, runId?: string): void {
    const current = this.contexts.get(sessionId);
    if (!current || (runId !== undefined && current.runId !== runId)) return;
    this.contexts.delete(sessionId);
    this.journalRecords.delete(sessionId);
  }

  get(sessionId: string): V3ToolExecutionContext | null {
    const context = this.contexts.get(sessionId);
    return context ? cloneContext(context) : null;
  }

  validate(
    sessionId: string,
    tool: Tool,
    params: Record<string, unknown>,
  ): V3ToolPolicyDecision {
    const context = this.contexts.get(sessionId);
    if (!context) return { allowed: true };

    const toolName = tool.name();
    if (!context.allowedTools.includes('*') && !context.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        code: 'tool_not_allowed',
        message: `Tool "${toolName}" is not granted to this v3 Run.`,
      };
    }

    const pathParams = tool.workspacePathParams();
    const mutatesWorkspace = tool.isDestructive()
      || (!tool.isReadOnly() && pathParams.length > 0)
      || toolName === 'Bash'
      || toolName === 'RunProgram';

    if (context.readOnly && mutatesWorkspace) {
      return {
        allowed: false,
        code: 'read_only_task',
        message: `Tool "${toolName}" is blocked because Task "${context.taskId}" is read-only.`,
      };
    }

    // Organization, task, message, and memory mutations are governed by their
    // own v3 domain policies. Workspace leases protect filesystem/process
    // effects only, not every tool whose generic isReadOnly() default is false.
    if (!mutatesWorkspace) return { allowed: true };
    if (!context.workspaceId || !context.workspaceRoot) {
      return {
        allowed: false,
        code: 'workspace_required',
        message: `Tool "${toolName}" requires a bound Workspace for this v3 Run.`,
      };
    }

    const leases = activeOwnedLeases(context);
    if (leases.length === 0) {
      return {
        allowed: false,
        code: 'lease_missing',
        message: `No active Workspace lease belongs to Run "${context.runId}".`,
      };
    }

    if (toolName === 'Bash' || toolName === 'RunProgram') {
      if (!leases.some((lease) => lease.writeScope.includes('.'))) {
        return {
          allowed: false,
          code: 'full_workspace_lease_required',
          message: `Tool "${toolName}" requires a full-Workspace lease.`,
        };
      }
      const command = toolName === 'Bash'
        ? stringParam(params, 'command')
        : [
          stringParam(params, 'program'),
          ...(Array.isArray(params.args) ? params.args.filter((value): value is string => typeof value === 'string') : []),
        ].join(' ');
      const cwd = resolveInsideWorkspace(
        context.workspaceRoot,
        stringParam(params, 'cwd') || '.',
      );
      if (!cwd) {
        return {
          allowed: false,
          code: 'cwd_outside_workspace',
          message: 'Command cwd must stay inside the task Workspace.',
        };
      }
      const commandDecision = this.commandPolicy.evaluate({
        toolName,
        workspaceRoot: context.workspaceRoot,
        cwd,
        command,
        mode: context.commandMode,
        network: context.commandNetwork,
        structured: toolName === 'RunProgram',
      });
      return commandDecision.allowed
        ? { allowed: true }
        : commandDecision;
    }

    if (pathParams.length === 0) {
      return leases.some((lease) => lease.writeScope.includes('.'))
        ? { allowed: true }
        : {
          allowed: false,
          code: 'full_workspace_lease_required',
          message: `Tool "${toolName}" has no auditable path parameters and requires a full-Workspace lease.`,
        };
    }

    for (const paramName of pathParams) {
      const raw = params[paramName];
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const relative = relativeWorkspacePath(context.workspaceRoot, raw);
      if (relative === null) {
        return {
          allowed: false,
          code: 'path_outside_workspace',
          message: `Path "${raw}" resolves outside the task Workspace.`,
        };
      }
      if (!context.writeScope.some((scope) => scopeCovers(scope, relative))) {
        return {
          allowed: false,
          code: 'undeclared_write_scope',
          message: `Path "${raw}" is outside Task "${context.taskId}" writeScope.`,
        };
      }
      if (!leases.some((lease) => lease.writeScope.some((scope) => scopeCovers(scope, relative)))) {
        return {
          allowed: false,
          code: 'lease_scope_violation',
          message: `Path "${raw}" is outside the active Workspace lease.`,
        };
      }
    }
    return { allowed: true };
  }

  async beforeTool(
    sessionId: string,
    tool: Tool,
    toolCallId: string,
  ): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context?.journal) return;
    const recordId = await context.journal.prepare({
      toolCallId,
      toolName: tool.name(),
      readOnly: tool.isReadOnly(),
      writeScope: tool.isReadOnly() ? [] : normalizeWriteScope(context.writeScope),
    });
    let records = this.journalRecords.get(sessionId);
    if (!records) {
      records = new Map();
      this.journalRecords.set(sessionId, records);
    }
    records.set(toolCallId, recordId);
    await context.journal.markStarted(recordId);
  }

  async afterTool(
    sessionId: string,
    toolCallId: string,
    result: ToolResult,
  ): Promise<void> {
    const context = this.contexts.get(sessionId);
    const recordId = this.journalRecords.get(sessionId)?.get(toolCallId);
    if (!context?.journal || !recordId) return;
    await context.journal.markFinished(recordId, result);
  }

  async markTranscriptCommitted(sessionId: string, toolCallId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context?.journal) return;
    await context.journal.markTranscriptCommitted(toolCallId);
    this.journalRecords.get(sessionId)?.delete(toolCallId);
  }
}

function activeOwnedLeases(context: V3ToolExecutionContext): WorkspaceLeaseRecord[] {
  const now = Date.now();
  return context.activeLeases.filter((lease) =>
    lease.status === 'active'
    && lease.workspaceId === context.workspaceId
    && lease.ownerRunId === context.runId
    && lease.ownerTaskId === context.taskId
    && lease.ownerAgentId === context.agentId
    && lease.fencingToken === context.fencingToken
    && Date.parse(lease.expiresAt) > now,
  );
}

function resolveInsideWorkspace(workspaceRoot: string, value: string): string | null {
  const root = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? candidate
    : null;
}

function relativeWorkspacePath(workspaceRoot: string, value: string): string | null {
  const absolute = resolveInsideWorkspace(workspaceRoot, value);
  if (!absolute) return null;
  const relative = path.relative(path.resolve(workspaceRoot), absolute).replace(/\\/g, '/');
  return relative || '.';
}

function scopeCovers(scope: string, candidate: string): boolean {
  return scope === '.' || candidate === scope || candidate.startsWith(`${scope}/`);
}

function stringParam(params: Record<string, unknown>, key: string): string {
  return typeof params[key] === 'string' ? params[key] : '';
}

function cloneContext(context: V3ToolExecutionContext): V3ToolExecutionContext {
  return {
    ...context,
    writeScope: normalizeWriteScope(context.writeScope),
    allowedTools: [...context.allowedTools],
    activeLeases: context.activeLeases.map((lease) => ({
      ...lease,
      writeScope: [...lease.writeScope],
    })),
  };
}
