/**
 * CommandResult — factory functions for command execution results.
 */

import type { CommandResult } from '../../../shared/types/command.js';

interface MakeResultOptions {
  durationMs?: number;
}

export function makeCommandResult(
  command: string,
  output: string,
  opts?: MakeResultOptions,
): CommandResult {
  return {
    success: true,
    command,
    output,
    durationMs: opts?.durationMs ?? 0,
  };
}

export function makeCommandError(
  command: string,
  errorMessage: string,
  opts?: MakeResultOptions,
): CommandResult {
  return {
    success: false,
    command,
    output: '',
    errorMessage,
    durationMs: opts?.durationMs ?? 0,
  };
}
