// EnvironmentSection — platform, shell, working directory, date
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import * as os from 'os';
import * as fs from 'fs';
import { SessionManager } from '../../session/index.js';
import { TokenCounter } from '../../context/TokenCounter.js';

/** Detect which shell the Bash tool actually runs on Windows */
function detectShell(): string {
  if (os.platform() !== 'win32') return process.env.SHELL || 'bash';
  // Git Bash — same priority order as BashTool.getShell()
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (fs.existsSync(gitBash)) return 'bash (Git Bash)';
  return 'cmd.exe (UTF-8)';
}


export const sectionMeta = {
  name: 'environment',
  type: 'dynamic' as const,
  priority: 120,
};
export function createEnvironmentSection(): SystemPromptSection {
  return {
    name: 'Environment',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      // Normalize to forward slashes — agent tool calls (Bash, Glob, etc.) must
      // not receive backslash paths because shells interpret \ as escape sequences.
      const rawWorkspace = session?.workspace || process.cwd();
      const workspace = rawWorkspace.replace(/\\/g, '/');
      const sessionType = session?.type || 'Main';
      const level = session?.level ?? 0;
      const shell = detectShell();

      return [
        '# Environment',
        ` - App root: ${process.cwd().replace(/\\/g, '/')}`,
        '   All built-in directories are at this root — you can Read/Write/Glob/Grep them directly.',
        '   │',
        '   ├── plugins/     — Plugin source code. Editable. One subdirectory per plugin.',
        '   │                   Each plugin has plugin.json + extension.js (or .ts).',
        '   ├── skills/      — 26 built-in skill definitions (SKILL.md files). Read-only.',
        '   ├── docs/        — Documentation: plugin-api.md, plugin-dev.md, design-md/ (74 brand DESIGN.md).',
        '   ├── data/        — Runtime data.',
        '   │   ├── agents/  — Agent config files (JSON). Read/Write to modify agent settings.',
        '   │   └── sessions/— Session transcripts (JSONL shards). Append-only, do NOT edit.',
        '   ├── config/      — Settings: settings.yaml, mcp_servers.yaml, auth.json.',
        '   ├── dist/        — Compiled server JS. Read-only (changes lost on restart).',
        '   └── logs/        — Server log files.',
        ` - Workspace (your working directory for file operations): ${workspace}`,
        '   This is your project folder. Use it for project files, not for finding built-in docs or plugins.',
        ` - Platform: ${os.platform()}`,
        ` - Shell: ${shell}`,
        ` - OS Version: ${os.platform() === 'win32' ? `${os.version()} ${os.release()}` : `${os.type()} ${os.release()}`}`,
        ` - Current date: ${new Date().toISOString()}`,
        ` - Session ID: ${ctx.sessionId}`,
        ` - Session type: ${sessionType}`,
        ` - Session level: ${level}`,
        '',
      ].join('\n');
    },
  };
}
