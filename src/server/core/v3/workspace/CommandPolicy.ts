import * as path from 'node:path';

export type CommandPolicyMode = 'standard' | 'strict';
export type CommandNetworkPolicy = 'allow' | 'deny';

export interface CommandPolicyRequest {
  toolName: 'Bash' | 'RunProgram';
  workspaceRoot: string;
  cwd: string;
  command: string;
  mode?: CommandPolicyMode;
  network?: CommandNetworkPolicy;
  structured?: boolean;
  environment?: NodeJS.ProcessEnv;
  allowedEnvironmentKeys?: readonly string[];
}

export type CommandPolicyDecision =
  | {
      allowed: true;
      workspaceRoot: string;
      cwd: string;
      environment: NodeJS.ProcessEnv;
    }
  | {
      allowed: false;
      code:
        | 'cwd_outside_workspace'
        | 'network_denied'
        | 'path_outside_workspace'
        | 'shell_disabled_in_strict_mode';
      message: string;
    };

const ALWAYS_ALLOWED_ENVIRONMENT = new Set([
  'CI',
  'COLORTERM',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NO_COLOR',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

const NETWORK_COMMAND = /(?:^|[\s;&|()])(?:curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)(?:[\s;&|()]|$)/i;
const NETWORK_PACKAGE_ACTION = /(?:^|[\s;&|()])(?:npm|pnpm|yarn|pip|pip3|cargo|go)\s+(?:add|install|get|update|upgrade|publish)(?:[\s;&|()]|$)/i;
const URL_REFERENCE = /\b(?:https?|ftp):\/\/\S+/i;

/**
 * A conservative policy guard for process tools.
 *
 * This is deliberately not described as a sandbox. It prevents accidental
 * cross-workspace execution and obvious network/path escapes before a command
 * reaches Bash/RunProgram. Strict mode requires a structured executor because
 * arbitrary shell text cannot be made safe by parsing alone.
 */
export class CommandPolicy {
  evaluate(request: CommandPolicyRequest): CommandPolicyDecision {
    const workspaceRoot = canonicalPath(request.workspaceRoot);
    const cwd = canonicalPath(request.cwd);
    if (!isWithin(workspaceRoot, cwd)) {
      return {
        allowed: false,
        code: 'cwd_outside_workspace',
        message: 'Command cwd must stay inside the task workspace.',
      };
    }

    if ((request.mode ?? 'standard') === 'strict' && !request.structured) {
      return {
        allowed: false,
        code: 'shell_disabled_in_strict_mode',
        message: 'Strict workspace mode disables arbitrary Bash and RunProgram commands.',
      };
    }

    if (
      (request.network ?? 'allow') === 'deny'
      && (
        NETWORK_COMMAND.test(request.command)
        || NETWORK_PACKAGE_ACTION.test(request.command)
        || URL_REFERENCE.test(request.command)
      )
    ) {
      return {
        allowed: false,
        code: 'network_denied',
        message: 'This task does not allow network-capable commands.',
      };
    }

    const outsidePath = findOutsideAbsolutePath(request.command, workspaceRoot);
    if (outsidePath) {
      return {
        allowed: false,
        code: 'path_outside_workspace',
        message: `Command references a path outside the task workspace: ${outsidePath}`,
      };
    }

    return {
      allowed: true,
      workspaceRoot,
      cwd,
      environment: sanitizeEnvironment(
        request.environment ?? process.env,
        request.allowedEnvironmentKeys ?? [],
      ),
    };
  }
}

function sanitizeEnvironment(
  environment: NodeJS.ProcessEnv,
  additionalKeys: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set([
    ...ALWAYS_ALLOWED_ENVIRONMENT,
    ...additionalKeys.map((key) => key.toUpperCase()),
  ]);
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value == null || !allowed.has(key.toUpperCase())) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function findOutsideAbsolutePath(command: string, workspaceRoot: string): string | null {
  const candidates = command.match(
    /(?:[A-Za-z]:[\\/][^\s"'`|;&<>]+|\\\\[^\\\s]+\\[^\s"'`|;&<>]+|(?<![.\w])\/(?:[^\s"'`|;&<>/]+\/)*[^\s"'`|;&<>]*)/g,
  ) ?? [];
  for (const rawCandidate of candidates) {
    const candidate = trimShellPunctuation(rawCandidate);
    if (!candidate || isUrlPath(candidate)) continue;
    const normalized = canonicalPath(candidate);
    if (!isWithin(workspaceRoot, normalized)) return candidate;
  }
  return null;
}

function trimShellPunctuation(value: string): string {
  return value.replace(/[),.:]+$/g, '');
}

function isUrlPath(value: string): boolean {
  return /^\/\//.test(value);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
