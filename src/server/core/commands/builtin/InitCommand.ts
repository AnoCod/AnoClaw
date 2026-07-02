/**
 * InitCommand — /init: generate a CLAUDE.md for the current project workspace.
 * Analyzes package.json, existing CLAUDE.md files, and directory structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from '../Command.js';
import type { CommandResult } from '../../../../shared/types/command.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { makeCommandResult, makeCommandError } from '../CommandResult.js';

export class InitCommand extends Command {
  name(): string { return 'init'; }
  description(): string { return 'Generate a CLAUDE.md file for the current project workspace'; }
  category(): 'project' { return 'project'; }

  displayName(): string { return 'Init Project'; }

  async execute(
    _args: Record<string, string>,
    ctx: ExecutionContext,
  ): Promise<CommandResult> {
    const workspace = ctx.workspace;
    if (!workspace || !fs.existsSync(workspace)) {
      return makeCommandError(this.name(), 'Workspace not found. Bind a workspace first.');
    }

    const targetPath = path.join(workspace, 'CLAUDE.md');

    // Back up existing CLAUDE.md if present
    if (fs.existsSync(targetPath)) {
      const bakPath = path.join(workspace, 'CLAUDE.md.bak');
      fs.copyFileSync(targetPath, bakPath);
    }

    // Analyze the project
    const projectInfo = this._analyzeProject(workspace);

    // Generate CLAUDE.md content
    const content = this._generateContent(projectInfo);

    // Write
    fs.writeFileSync(targetPath, content, 'utf-8');

    return makeCommandResult(this.name(), `## /init — Project initialized

Generated **CLAUDE.md** in workspace${fs.existsSync(path.join(workspace, 'CLAUDE.md.bak')) ? ' (existing file backed up to CLAUDE.md.bak)' : ''}.

**Detected:**
- Project: **${projectInfo.name}**
- Tech stack: ${projectInfo.techStack.join(', ') || 'unknown'}
- Main directories: ${projectInfo.dirs.join(', ') || 'none significant'}

The new CLAUDE.md includes task routing, build commands, and a directory map. Review and customize it for your project.`);
  }

  // ── Analysis ──

  private _analyzeProject(workspace: string): ProjectInfo {
    const info: ProjectInfo = {
      name: path.basename(workspace),
      techStack: [],
      dirs: [],
      buildCommands: [],
      hasClaudeMd: false,
    };

    // Read package.json for tech stack detection
    const pkgPath = path.join(workspace, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        info.name = pkg.name || info.name;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.typescript) info.techStack.push('TypeScript');
        if (deps.react) info.techStack.push('React');
        if (deps.vue) info.techStack.push('Vue');
        if (deps.next) info.techStack.push('Next.js');
        if (deps.express || deps.koa) info.techStack.push('Node.js HTTP');
        if (deps.tailwindcss) info.techStack.push('Tailwind CSS');
        if (deps.vitest || deps.jest) info.techStack.push(deps.vitest ? 'Vitest' : 'Jest');
        if (deps['@anthropic-ai/sdk'] || deps.openai) info.techStack.push('AI/LLM');
        if (pkg.scripts) {
          for (const [name, cmd] of Object.entries(pkg.scripts) as [string, string][]) {
            if (['build', 'dev', 'test', 'start', 'lint'].includes(name)) {
              info.buildCommands.push({ name, command: cmd });
            }
          }
        }
      } catch { /* package.json parse error — non-critical */ }
    }

    // Check for existing CLAUDE.md files
    const claudeFiles = this._findClaudeMdFiles(workspace);
    info.hasClaudeMd = claudeFiles.length > 0;

    // Top-level directories (excluding node_modules, .git, dist, etc.)
    if (fs.existsSync(workspace)) {
      const entries = fs.readdirSync(workspace, { withFileTypes: true });
      const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__', '.venv', 'venv']);
      info.dirs = entries
        .filter((e) => e.isDirectory() && !skipDirs.has(e.name) && !e.name.startsWith('.'))
        .map((e) => e.name)
        .slice(0, 12);
    }

    // If no tech stack detected from package.json, try other signals
    if (info.techStack.length === 0) {
      if (fs.existsSync(path.join(workspace, 'go.mod'))) info.techStack.push('Go');
      if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) info.techStack.push('Rust');
      if (fs.existsSync(path.join(workspace, 'requirements.txt')) || fs.existsSync(path.join(workspace, 'pyproject.toml'))) info.techStack.push('Python');
      if (fs.existsSync(path.join(workspace, 'Gemfile'))) info.techStack.push('Ruby');
    }

    return info;
  }

  private _findClaudeMdFiles(workspace: string): string[] {
    const results: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else if (e.name === 'CLAUDE.md') {
            results.push(full);
          }
        }
      } catch { /* permission errors — skip */ }
    };
    walk(workspace, 0);
    return results;
  }

  // ── Content generation ──

  private _generateContent(info: ProjectInfo): string {
    const lines: string[] = [
      `# ${info.name}`,
      '',
      '## Tech Stack',
    ];

    if (info.techStack.length > 0) {
      for (const tech of info.techStack) {
        lines.push(`- ${tech}`);
      }
    } else {
      lines.push('- (auto-detect — add your stack here)');
    }

    lines.push('', '## Build Commands');
    if (info.buildCommands.length > 0) {
      for (const bc of info.buildCommands) {
        lines.push(`- \`${bc.command}\` — ${bc.name}`);
      }
    } else {
      lines.push('- `npm run build` — build');
      lines.push('- `npm run dev` — start dev server');
      lines.push('- `npm test` — run tests');
    }

    lines.push('', '## Directory Map');
    lines.push('```');
    for (const dir of info.dirs) {
      lines.push(`├── ${dir}/`);
    }
    lines.push('```');

    lines.push('', '## Quick Task Routing');
    lines.push('');
    lines.push('| Task | Key Files |');
    lines.push('|------|------|');
    lines.push('| (add your routing here) | |');

    lines.push('', '## Conventions');
    lines.push('- (add your project conventions here)');

    return lines.join('\n') + '\n';
  }
}

interface ProjectInfo {
  name: string;
  techStack: string[];
  dirs: string[];
  buildCommands: { name: string; command: string }[];
  hasClaudeMd: boolean;
}
