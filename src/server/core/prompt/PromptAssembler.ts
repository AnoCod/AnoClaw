// PromptAssembler — singleton that assembles the full system prompt
// Registry of 21 sections (8 static + 13 dynamic)
// Layout: override > provider-cacheable prefix > volatile suffix

import { EventEmitter } from 'events';
import { BOUNDARY_MARKER } from '../../../shared/constants.js';
import {
  SystemPromptSection,
  CacheScope,
  PromptContext,
} from './PromptSection.js';
import { PromptCache } from './PromptCache.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { createLogger } from '../logger.js';
import type { ILogger } from '../interfaces/ILogger.js';

import { registerAllSections } from './sections/registerAllSections.js';

export interface PromptOverride {
  content: string;
}

export type PromptBuildContext = Partial<Omit<PromptContext, 'agentId' | 'sessionId'>>;

export interface PromptLayoutStats {
  totalTokens: number;
  cacheablePrefixTokens: number;
  volatileTokens: number;
  cacheablePrefixRatio: number;
}

interface PromptAssembly {
  prompt: string;
  cacheablePrefix: string;
  volatileSuffix: string;
}

const PROVIDER_CACHEABLE_DYNAMIC_SECTIONS = new Set<string>([
  'ToolPrompt',
  'Tools',
  'Skills',
]);

// ── Default role prompt templates (agent name injected at assembly) ──

// Default role prompt templates (agent name injected at assembly)

function mainAgentPrompt(name: string): string {
  return [
    `You are ${name}, the MainAgent and CEO of an AI organization running on AnoClaw.`,
    '',
    'AnoClaw is the desktop platform; it is not your name. You own the user outcome from intake to final answer.',
    '',
    '## Operating Model',
    '- Understand the user goal, success criteria, constraints, and current workspace state.',
    '- Decide whether to execute directly, delegate to permanent team members, or spawn a temporary helper.',
    '- Keep the work coherent: every delegated result must be integrated into one user-facing answer or finished artifact.',
    '- Prefer direct execution for narrow tasks. Delegate when specialization, parallelism, or context separation improves the result.',
    '- Ask the user only for decisions that cannot be inferred and would materially change the outcome.',
    '',
    '## Multi-Agent Leadership',
    '- Use Managers for domain ownership and cross-file or cross-system work that benefits from review.',
    '- Use Members for focused specialist execution with clear acceptance criteria.',
    '- Use SubAgentSpawn for temporary research, exploration, or isolated subtasks that should not become durable team context.',
    '- Do not delegate vague work. Every assignment must include: goal, scope, relevant context, constraints, acceptance criteria, priority, and expected report format.',
    '- You remain accountable for the final answer. Review child output for completeness, contradictions, and verification before reporting to the user.',
    '',
    '## Delegation Discipline (CRITICAL)',
    '- One parent-agent pair has one persistent child session. The child conversation is reused across tasks and keeps durable context.',
    '- TaskAssign starts or queues durable work in that child session. It is for a distinct task with its own acceptance criteria.',
    '- AgentMessage is for mid-task clarification, new constraints, course correction, or soft interruption. Use it instead of creating a duplicate assignment.',
    '- Before delegating, check active tasks. If equivalent work is already running, amend it with AgentMessage or wait for its notification.',
    '- After delegating, trust task notifications. You will receive a <task-notification> when work completes or fails.',
    '- TaskList is for oversight, not polling. Use it when you are otherwise idle, coordinating many tasks, or a task appears stuck.',
    '',
    '## Runtime Safety',
    '- Bash commands run on the same machine and process tree as AnoClaw. Do not kill parent Node/Electron processes.',
    '- If a server restart is needed after source edits, use RestartServer; it checkpoints and resumes safely.',
    '- Plugins auto-reload via the file watcher. Write plugin files directly; restart only when the runtime requires it.',
    '',
    '## Communication',
    '- Be concise with the user. State decisions, results, verification, and blockers.',
    '- If hard-to-explain architecture or data flow would benefit from a visual, output interactive HTML; the frontend can render it inline.',
  ].join('\n');
}

function managerPrompt(name: string): string {
  return [
    `You are ${name}, an AnoClaw Manager: a domain owner who reports to the MainAgent and manages specialist Members.`,
    '',
    '## Operating Model',
    '- Own your domain outcome. You are not a message router.',
    '- Start by understanding the assignment, success criteria, relevant context, and constraints.',
    '- Execute directly when that is the fastest reliable path.',
    '- Delegate to Members when their specialization, parallel execution, or independent review improves the result.',
    '- Review all Member output before reporting upward. Your report is accountable for quality.',
    '',
    '## Delegation Standards',
    'Every TaskAssign to a Member must include:',
    '- Goal and business/user context.',
    '- Scope: files, systems, or data to inspect or change.',
    '- Constraints: what not to touch, compatibility requirements, safety limits.',
    '- Acceptance criteria and required verification.',
    '- Priority and expected report format.',
    '',
    'Use AgentMessage for updates to running work: clarifications, changed requirements, review feedback, or cancellation guidance. Do not start a second TaskAssign for the same active work.',
    '',
    '## Quality Gate',
    '- Validate assumptions against code, logs, tests, or tool output before passing work upward.',
    '- If a Member result is incomplete, send precise feedback and request revision.',
    '- If you change or approve code, ensure verification is explicit: test command, build command, manual check, or why verification was not possible.',
    '- Save durable team knowledge with memory_save when it will help future agents.',
    '',
    '## Communication',
    '- Upward: concise and decision-ready. Done: X. Verified: Y. Notes: Z.',
    '- Downward: specific, bounded, and actionable.',
    '- AgentMessage is downward only; never message your superior through it.',
    '- If blocked after focused attempts, report the blocker, what was tried, and the exact input needed.',
  ].join('\n');
}

function memberPrompt(name: string): string {
  return [
    `You are ${name}, an AnoClaw Member: a domain specialist who executes assigned work and self-verifies before reporting.`,
    '',
    '## Operating Model',
    '1. Receive: identify the goal, scope, constraints, and acceptance criteria in the assignment.',
    '2. Ground: read relevant files, logs, memories, or tool output before acting.',
    '3. Execute: make the smallest complete change that satisfies the assignment and matches existing patterns.',
    '4. Verify: run the relevant check or explain exactly why it could not be run.',
    '5. Report: summarize what changed, how it was verified, and any risks or assumptions.',
    '',
    '## Execution Principles',
    '- Stay inside scope. Do not add unrelated features, cleanups, or speculative abstractions.',
    '- Prefer evidence over guesses. If context is missing, make a reasonable assumption only when safe and state it.',
    '- Keep TaskList current when work is multi-step or delegated.',
    '- Use SubAgentSpawn only for a clearly bounded helper task such as research, isolated inspection, or parallel verification.',
    '- If blocked after focused attempts, stop and report: blocker, tried approaches, and exact need.',
    '',
    '## Delivery Checklist',
    '- The requested goal is achieved.',
    '- Acceptance criteria are satisfied or explicitly called out as unmet.',
    '- Verification was performed or the limitation is stated.',
    '- No secrets, debug artifacts, placeholders, or dead comments were introduced.',
    '- The report is concise enough for a Manager to review quickly.',
  ].join('\n');
}
const DEFAULT_AGENT_PROMPTS: Record<string, (agentName: string) => string> = {
  MainAgent: mainAgentPrompt,
  Manager: managerPrompt,
  Member: memberPrompt,
};

function normalizeRolePrompt(role: string, prompt: string): string {
  void role;
  return prompt;
}

export class PromptAssembler extends EventEmitter {
  private static _instance: PromptAssembler;
  private _logger: ILogger | null = null;

  static getInstance(): PromptAssembler {
    if (!this._instance) {
      this._instance = new PromptAssembler();
    }
    return this._instance;
  }

  setLogger(logger: ILogger): void { this._logger = logger; }
  private get log(): ILogger { return this._logger || createLogger('anochat.core'); }

  private _cache: PromptCache = new PromptCache();

  /** All registered sections (static + dynamic) */
  private _staticSections: SystemPromptSection[] = [];
  private _dynamicSections: SystemPromptSection[] = [];

  /** Runtime-injected CustomCLI instructions (Priority 2) */
  private _customCLIInstructions: string | null = null;

  /** ExtensionPoints registry — injected by PluginHostManager at startup */
  private _extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null } | null = null;

  /** Inject ExtensionPoints registry for plugin prompt overrides. Called at startup. */
  setExtensionPoints(extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null }): void {
    this._extPoints = extPoints;
  }

  private constructor() {
    super();

    // Register all prompt sections via the centralized registration function.
    // Sections are sorted by priority inside their registered zone.
    registerAllSections(this);
  }

  // ─── Registration API ───────────────────────────────────────

  /** Register a new section (adds to dynamic zone by default) */
  registerSection(
    section: SystemPromptSection,
    zone: 'static' | 'dynamic' = 'dynamic',
  ): void {
    if (zone === 'static') {
      this._staticSections.push(section);
    } else {
      this._dynamicSections.push(section);
    }
    this.clearAllCaches();
  }

  unregisterSectionsByPrefix(prefix: string): number {
    const removeMatching = (sections: SystemPromptSection[]) => {
      const before = sections.length;
      const kept = sections.filter(section => !section.name.startsWith(prefix));
      return { kept, removed: before - kept.length };
    };

    const staticResult = removeMatching(this._staticSections);
    const dynamicResult = removeMatching(this._dynamicSections);
    const removed = staticResult.removed + dynamicResult.removed;
    if (removed > 0) {
      this._staticSections = staticResult.kept;
      this._dynamicSections = dynamicResult.kept;
      this.clearAllCaches();
    }
    return removed;
  }

  /** Get all section names for diagnostics */
  get sectionNames(): string[] {
    return [
      ...this._staticSections.map(s => s.name),
      ...this._dynamicSections.map(s => s.name),
    ];
  }

  // ─── Build ──────────────────────────────────────────────────

  /**
   * Build the full effective system prompt for a given agent + session.
   *
   * Priority chain:
   *   0: Override — return override content directly
   *   1: Provider-cacheable prefix — static rules + agent definition + stable capabilities
   *   2: Volatile suffix — session/workspace/run-state sections after BOUNDARY_MARKER
   */
  buildEffectivePrompt(
    agentId: string,
    sessionId: string,
    override?: PromptOverride,
    buildContext?: PromptBuildContext,
  ): string {
    // Priority 0: Plugin Override — ExtensionPoints.promptAssembler
    if (this._extPoints) {
      const pluginOverride = this._extPoints.get('promptAssembler');
      if (pluginOverride) {
        try {
          const result = pluginOverride({ agentId, sessionId, override, buildContext, assembler: this });
          if (typeof result === 'string') return result;
        } catch (err) {
          this.log.warn('Plugin prompt override failed', { error: (err as Error).message });
        }
      }
    }

    // Priority 1: Override — user-provided complete prompt via API
    if (override && override.content) {
      return override.content;
    }

    const ctx: PromptContext = { agentId, sessionId, ...buildContext };
    const assembly = this.assembleStandardPrompt(ctx);

    // Emit event with token count
    const layout = this.computeLayoutStats(assembly.prompt, assembly.cacheablePrefix, assembly.volatileSuffix);
    this.log.debug('Prompt assembled', {
      aid: agentId,
      sid: sessionId,
      estimatedTokens: layout.totalTokens,
      cacheablePrefixTokens: layout.cacheablePrefixTokens,
      volatileTokens: layout.volatileTokens,
    });
    this.emit('promptBuilt', agentId, layout.totalTokens, { cacheablePrefixTokens: layout.cacheablePrefixTokens });

    return assembly.prompt;
  }

  /**
   * Estimate the standard prompt layout without plugin/user complete overrides.
   * This is mainly for diagnostics: provider-side prompt caching only helps when
   * the beginning of the request is byte-identical across calls.
   */
  analyzePromptLayout(
    agentId: string,
    sessionId: string,
    buildContext?: PromptBuildContext,
  ): PromptLayoutStats {
    const ctx: PromptContext = { agentId, sessionId, ...buildContext };
    const assembly = this.assembleStandardPrompt(ctx);
    return this.computeLayoutStats(assembly.prompt, assembly.cacheablePrefix, assembly.volatileSuffix);
  }

  /**
   * Estimate cache layout from an already-built prompt without recomputing
   * sections. Useful for preview routes and diagnostics that need no side effects.
   */
  analyzePromptText(prompt: string): PromptLayoutStats {
    const boundaryIndex = prompt.indexOf(BOUNDARY_MARKER);
    if (boundaryIndex < 0) {
      return this.computeLayoutStats(prompt, prompt, '');
    }

    const cacheablePrefix = prompt.slice(0, boundaryIndex).trim();
    const volatileSuffix = prompt.slice(boundaryIndex + BOUNDARY_MARKER.length).trim();
    return this.computeLayoutStats(prompt, cacheablePrefix, volatileSuffix);
  }

  private computeLayoutStats(
    prompt: string,
    cacheablePrefix: string,
    volatileSuffix: string,
  ): PromptLayoutStats {
    const totalTokens = TokenCounter.estimate(prompt);
    const cacheablePrefixTokens = TokenCounter.estimate(cacheablePrefix);
    const volatileTokens = TokenCounter.estimate(volatileSuffix);

    return {
      totalTokens,
      cacheablePrefixTokens,
      volatileTokens,
      cacheablePrefixRatio: totalTokens > 0 ? cacheablePrefixTokens / totalTokens : 0,
    };
  }

  private assembleStandardPrompt(ctx: PromptContext): PromptAssembly {
    const cacheablePrefixParts: string[] = [];

    // Global static rules are shared by every agent and are always first.
    cacheablePrefixParts.push(this.buildStaticZone(ctx));

    // Agent identity and stable custom instructions should be before volatile
    // session state so provider prefix caches can reuse them across turns.
    cacheablePrefixParts.push(this.buildAgentDefinition(ctx.agentId));
    if (this._customCLIInstructions) {
      cacheablePrefixParts.push(this._customCLIInstructions);
    }

    // These sections can still recompute locally, but their text is normally
    // stable for the same agent/mode and therefore valuable for LLM prefix cache.
    cacheablePrefixParts.push(this.buildDynamicZone(ctx, {
      include: PROVIDER_CACHEABLE_DYNAMIC_SECTIONS,
    }));

    const cacheablePrefix = cacheablePrefixParts.filter(Boolean).join('\n\n');
    const volatileSuffix = this.buildDynamicZone(ctx, {
      exclude: PROVIDER_CACHEABLE_DYNAMIC_SECTIONS,
    });
    const prompt = [cacheablePrefix, BOUNDARY_MARKER, volatileSuffix]
      .filter(Boolean)
      .join('\n\n');

    return { prompt, cacheablePrefix, volatileSuffix };
  }

  private buildAgentDefinition(agentId: string): string {
    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);
    if (!agent) return '';

    const roleFn = DEFAULT_AGENT_PROMPTS[agent.role];
    const roleDefault = roleFn ? normalizeRolePrompt(agent.role, roleFn(agent.name)) : '';
    return [roleDefault, agent.agentPrompt].filter(Boolean).join('\n\n');
  }

  // ─── Static Zone (globally cached) ──────────────────────────

  private buildStaticZone(ctx: PromptContext): string {
    const results: string[] = [];
    for (const sec of this._staticSections) {
      const cacheKey = `global:${sec.name}`;
      if (!sec.cacheBreak && this._cache.has(cacheKey)) {
        results.push(this._cache.get(cacheKey)!);
      } else {
        const t0 = Date.now();
        const content = sec.compute(ctx);
        this.log.debug('Static section computed', { section: sec.name, durationMs: Date.now() - t0, cached: false });
        this._cache.set(cacheKey, content, CacheScope.Global);
        results.push(content);
      }
    }
    return results.filter(Boolean).join('\n\n');
  }

  // ─── Dynamic Zone (per-session cached) ──────────────────────

  private buildDynamicZone(
    ctx: PromptContext,
    options: { include?: ReadonlySet<string>; exclude?: ReadonlySet<string> } = {},
  ): string {
    const results: string[] = [];
    for (const sec of this._dynamicSections) {
      if (options.include && !options.include.has(sec.name)) continue;
      if (options.exclude && options.exclude.has(sec.name)) continue;

      const cacheKey = `${ctx.agentId}:${ctx.sessionId}:${sec.name}`;
      if (!sec.cacheBreak && this._cache.has(cacheKey)) {
        results.push(this._cache.get(cacheKey)!);
      } else {
        const t0 = Date.now();
        const content = sec.compute(ctx);
        this.log.debug('Dynamic section computed', { section: sec.name, durationMs: Date.now() - t0 });
        this._cache.set(cacheKey, content, CacheScope.Session);
        results.push(content);
      }
    }
    return results.filter(Boolean).join('\n\n');
  }

  // ─── Cache management ───────────────────────────────────────

  /** Invalidate cache at the given scope */
  invalidateCache(scope: CacheScope, agentId?: string, sessionId?: string): void {
    switch (scope) {
      case CacheScope.Global:
        this._cache.invalidateGlobal();
        break;
      case CacheScope.Agent:
        if (agentId) this._cache.invalidateAgent(agentId);
        break;
      case CacheScope.Session:
        if (sessionId) this._cache.invalidateSession(sessionId);
        break;
    }
    this.emit('cacheInvalidated', scope, agentId, sessionId);
  }

  /** Clear all caches */
  clearAllCaches(): void {
    this._cache.invalidateAll();
    this.emit('cacheInvalidated', 'all');
  }

  /** Memory was written for a given agent */
  onMemoryWritten(agentId: string): void {
    this._cache.onMemoryWritten(agentId);
  }

  /** User issued /clear — bust that session's dynamic cache */
  onClear(agentId: string, sessionId: string): void {
    this._cache.onClear(agentId, sessionId);
  }

  // ─── CustomCLI (Priority 2) ────────────────────────────────────

  /** Set runtime-injected CustomCLI instructions. Pass null/empty to clear. */
  setCustomCLI(instructions: string | null): void {
    this._customCLIInstructions = instructions || null;
  }

  /** Get current CustomCLI instructions. */
  get customCLI(): string | null {
    return this._customCLIInstructions;
  }

  // ─── Diagnostics ────────────────────────────────────────────

  get cacheStats(): { global: number; session: number } {
    return {
      global: this._cache.globalSize,
      session: this._cache.sessionSize,
    };
  }
}
