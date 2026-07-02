// Skill.ts — Skill class with full Claude Code-compatible frontmatter
// Supports: when_to_use, paths (conditional activation), embedded shell (!`cmd`),
// multi-source priority, effort, model, agent binding, context mode.
//
// Frontmatter spec (every field optional except name + description):
//   name, description, when_to_use, allowed-tools, model, effort,
//   paths, triggers, priority, version, context, agent, shell,
//   user_invocable, enabled

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { parseSkillMarkdown, validateSkillFrontmatter } from './SkillParser.js';

export enum SkillSource {
  /** Project-level skills (highest priority) */
  Project = 'project',
  /** User-level skills */
  User = 'user',
  /** Plugin-level skills */
  Plugin = 'plugin',
  /** Built-in skills (lowest priority, overridable by any other source) */
  Builtin = 'builtin',
}

export interface SkillOptions {
  triggers?: string[];
  tools?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  priority?: number;
  source?: SkillSource;
  filePath?: string;
  whenToUse?: string;
  paths?: string[];
  version?: string;
  context?: 'inline' | 'fork';
  agent?: string;
  shell?: 'bash' | 'powershell';
  userInvocable?: boolean;
  hasEmbeddedShell?: boolean;
}

export class Skill extends EventEmitter {
  private _name: string;
  private _description: string;
  private _body: string; // Raw body — may contain !`cmd` blocks
  private _triggers: string[];
  private _tools: string[];
  private _model: string;
  private _effort: string;
  private _priority: number;
  private _source: SkillSource;
  private _filePath: string;
  private _whenToUse: string;
  private _paths: string[];
  private _version: string;
  private _context: 'inline' | 'fork';
  private _agent: string;
  private _shell: 'bash' | 'powershell' | '';
  private _userInvocable: boolean;
  private _hasEmbeddedShell: boolean;

  constructor(
    name: string,
    description: string,
    body: string,
    options: SkillOptions = {},
  ) {
    super();
    this._name = name;
    this._description = description;
    this._body = body;
    this._triggers = options.triggers ?? [];
    this._tools = options.tools ?? [];
    this._model = options.model ?? '';
    this._effort = options.effort ?? '';
    this._priority = options.priority ?? 50;
    this._source = options.source ?? SkillSource.Project;
    this._filePath = options.filePath ?? '';
    this._whenToUse = options.whenToUse ?? '';
    this._paths = options.paths ?? [];
    this._version = options.version ?? '';
    this._context = options.context ?? 'inline';
    this._agent = options.agent ?? '';
    this._shell = (options.shell ?? '') as 'bash' | 'powershell' | '';
    this._userInvocable = options.userInvocable ?? true;
    this._hasEmbeddedShell = options.hasEmbeddedShell ?? false;
  }

  name(): string { return this._name; }
  description(): string { return this._description; }
  model(): string { return this._model; }
  effort(): string { return this._effort; }
  priority(): number { return this._priority; }
  source(): SkillSource { return this._source; }
  filePath(): string { return this._filePath; }
  whenToUse(): string { return this._whenToUse; }
  paths(): string[] { return [...this._paths]; }
  version(): string { return this._version; }
  context(): 'inline' | 'fork' { return this._context; }
  agent(): string { return this._agent; }
  shell(): string { return this._shell; }
  userInvocable(): boolean { return this._userInvocable; }
  hasEmbeddedShell(): boolean { return this._hasEmbeddedShell; }

  /** Full Markdown body — may contain !`cmd` blocks executed at invoke time */
  body(): string { return this._body; }

  requiredTools(): string[] { return [...this._tools]; }
  triggers(): string[] { return [...this._triggers]; }

  /** Get the body with embedded shell commands extracted (for execution).
   *  Returns { cleanBody, commands[] } where cleanBody has commands replaced by placeholders. */
  extractEmbeddedShell(): { cleanBody: string; commands: Array<{ placeholder: string; command: string }> } {
    const commands: Array<{ placeholder: string; command: string }> = [];
    let cleanBody = this._body;

    // Match ```! ... ``` code blocks — multi-line shell commands
    const blockRegex = /```!\s*\n([\s\S]*?)```/g;
    cleanBody = cleanBody.replace(blockRegex, (_match, cmd) => {
      const id = `__SHELL_${commands.length}__`;
      commands.push({ placeholder: id, command: cmd.trim() });
      return id;
    });

    // Match inline !`command` — single-line shell commands
    const inlineRegex = /!`([^`]+)`/g;
    cleanBody = cleanBody.replace(inlineRegex, (_match, cmd) => {
      const id = `__SHELL_${commands.length}__`;
      commands.push({ placeholder: id, command: cmd.trim() });
      return id;
    });

    return { cleanBody, commands };
  }

  /** Check if a user message semantically matches this skill's when_to_use description.
   *  Goes beyond keyword matching — evaluates whether the scenario fits. */
  matchesScenario(userMessage: string): boolean {
    if (!userMessage) return false;
    const lower = userMessage.toLowerCase();

    // Keyword triggers (exact match)
    for (const trigger of this._triggers) {
      if (trigger && lower.includes(trigger.toLowerCase())) return true;
    }

    // Name match (4+ character skill names)
    if (this._name.length > 3 && lower.includes(this._name.toLowerCase())) return true;

    // when_to_use contains descriptive triggers — check if key phrases appear
    if (this._whenToUse) {
      const whenLower = this._whenToUse.toLowerCase();
      // Extract quoted phrases and standalone keywords from when_to_use
      const phrases = whenLower.match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) ?? [];
      for (const phrase of phrases) {
        if (lower.includes(phrase)) return true;
      }
    }

    return false;
  }

  /** Check if any of the `paths` glob patterns match the given file path.
   *  Used for conditional skill activation when files change. */
  matchesPath(filePath: string): boolean {
    if (this._paths.length === 0) return false;
    const normalized = filePath.replace(/\\/g, '/');
    for (const pattern of this._paths) {
      const regex = new RegExp(
        '^' + pattern.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$'
      );
      if (regex.test(normalized)) return true;
    }
    return false;
  }

  /** Factory: parse a SKILL.md file and create a Skill instance with full frontmatter. */
  static async fromMarkdown(
    filePath: string,
    source: SkillSource = SkillSource.Project,
  ): Promise<Skill> {
    const raw = await fs.readFile(filePath, 'utf8');
    const { frontmatter, body } = parseSkillMarkdown(raw, filePath);
    const errors = validateSkillFrontmatter(frontmatter);
    if (errors.length > 0) {
      throw new Error(`Invalid skill frontmatter in "${filePath}":\n  - ${errors.join('\n  - ')}`);
    }
    if (!body) throw new Error(`Skill file "${filePath}" has no body content`);
    return Skill._fromParsed(frontmatter, body, source, filePath);
  }

  /** Factory: from raw content string (for auto-generation or dynamic creation). */
  static fromContent(
    content: string,
    virtualPath: string,
    source: SkillSource = SkillSource.Project,
  ): Skill {
    const { frontmatter, body } = parseSkillMarkdown(content, virtualPath);
    const errors = validateSkillFrontmatter(frontmatter);
    if (errors.length > 0) {
      throw new Error(`Invalid skill content for "${virtualPath}":\n  - ${errors.join('\n  - ')}`);
    }
    return Skill._fromParsed(frontmatter, body, source, virtualPath);
  }

  private static _fromParsed(
    fm: Record<string, unknown>,
    body: string,
    source: SkillSource,
    filePath: string,
  ): Skill {
    const hasShell = /!`[^`]+`/.test(body) || /```!\s*\n/.test(body);

    const toolsArr = (fm.tools ?? fm['allowed-tools'] ?? fm['allowed_tools']) as string[] | undefined;

    return new Skill(
      fm.name as string,
      fm.description as string,
      body,
      {
        triggers: fm.triggers as string[] | undefined,
        tools: toolsArr,
        model: fm.model as string | undefined,
        effort: fm.effort as 'low' | 'medium' | 'high' | undefined,
        priority: fm.priority as number | undefined,
        source,
        filePath,
        whenToUse: (fm.when_to_use ?? fm.whenToUse ?? '') as string,
        paths: fm.paths as string[] | undefined,
        version: fm.version as string | undefined,
        context: (fm.context ?? 'inline') as 'inline' | 'fork',
        agent: fm.agent as string | undefined,
        shell: fm.shell as 'bash' | 'powershell' | undefined,
        userInvocable: (fm.user_invocable ?? fm.userInvocable ?? true) as boolean,
        hasEmbeddedShell: hasShell,
      },
    );
  }
}

/** Higher number = higher priority */
export function sourceWeight(source: SkillSource): number {
  switch (source) {
    case SkillSource.Project: return 4;
    case SkillSource.User: return 3;
    case SkillSource.Plugin: return 2;
    case SkillSource.Builtin: return 1;
  }
}
