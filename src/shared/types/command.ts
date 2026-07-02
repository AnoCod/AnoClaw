/**
 * Slash command type contracts shared between frontend and backend.
 */

export interface CommandArg {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'boolean' | 'number';
}

export interface CommandDefinition {
  name: string;
  displayName: string;
  description: string;
  category: 'session' | 'project' | 'workspace' | 'help';
  args?: CommandArg[];
}

export interface CommandResult {
  success: boolean;
  command: string;
  output: string;
  errorMessage?: string;
  durationMs: number;
}
