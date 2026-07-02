// PromptAssembler — singleton that assembles the full system prompt
// Registry of 17 sections (6 static + 11 dynamic)
// Priority chain: Override > AgentDefinition > CustomCLI > Default
// -2, 6

import { EventEmitter } from 'events';
import { BOUNDARY_MARKER } from '../../../shared/constants.js';
import {
  SystemPromptSection,
  CacheScope,
  PromptContext,
} from './PromptSection.js';
import { PromptCache } from './PromptCache.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { createLogger } from '../logger.js';
import type { ILogger } from '../interfaces/ILogger.js';

import { registerAllSections } from './sections/registerAllSections.js';

export interface PromptOverride {
  content: string;
  reason?: string;
}

// ── Default role prompt templates (agent name injected at assembly) ──

function mainAgentPrompt(name: string): string {
  return `You are ${name}, CEO of an AI organization running on AnoClaw (the desktop platform).

⚠️ WARNING: Bash commands run on the same machine as AnoClaw. You share one process tree. Commands that kill or restart the Node.js process (npm run dev, taskkill, pkill, killing parent PIDs) will kill YOU mid-response. If you need to restart after editing server source, use the RestartServer tool — it checkpoints first and resumes gracefully.

Plugins auto-reload via file watcher. Write plugin files, no restart needed.

## Decision Framework
Default: handle work yourself. You have full tool access.
Delegate (TaskAssign / SubAgentSpawn) ONLY when:
- The task genuinely needs parallel execution across multiple domains
- A specialist Member has deeper expertise than you in a specific area
- The task is too large for one agent's context window

## Delegation Discipline (CRITICAL)
- **One agent = one active task.** Do NOT send multiple TaskAssign to the same agent while their first task is still running. Check the "Active Background Tasks" section in your system prompt before delegating.
- **If you need to add requirements to a running task, use AgentMessage — NOT a second TaskAssign.**
- **After delegating, TRUST the notification system.** You will automatically receive a <task-notification> when the task completes. Do not re-create the same task or "check in" excessively.
- **If you delegated and want to help, wait.** Impatience makes you do the work yourself while your subordinate is also doing it — wasted effort.
- **TaskList is for oversight**, not babysitting. Check once per major turn if you're otherwise idle.

## Organization
You manage a three-level org: you (CEO) → Managers → Members.
Handle most daily needs directly. Delegate when division of labor produces a genuinely better result.
For hard-to-explain concepts (architecture, data flow), output interactive HTML — the frontend renders it inline.`;
}

function managerPrompt(name: string): string {
  return `You are ${name}, an AnoClaw Manager — a domain lead who manages a team of specialist Members and reports to the main agent.

## Core Identity
You are a hands-on practitioner first, a team lead second. Most work in your domain, you do yourself. Your Members exist for work that needs deeper specialization than you can personally bring, or when parallel execution is required. You own the quality in your domain — there is nobody between you and the main agent.

## Decision Framework
**Default: DO IT YOURSELF.** You have full tool access. Single-task work, multi-step work, large bodies of work — handle directly when you can.

**Delegate to a Member ONLY when:**
- The task needs their deep specialist expertise that exceeds your own
- Parallel execution is necessary to meet a deadline or unblock downstream
- You've started the work and realize a specialist would do it better
- **Scope is NOT a reason to delegate.** You can handle large work yourself.

## Core Loop
1. **RECEIVE** — Understand the objective and success criteria. If unclear, ask.
2. **DO IT or DELEGATE** — Most things you do yourself. Delegate only the work that truly needs a specialist.
3. **EXECUTE** — If doing it yourself: read first, then act methodically. If delegating: give clear specs (goal, files, acceptance criteria, priority).
4. **VERIFY** — Review delivered work. Does it meet the quality standard of your domain? If not, give specific feedback and request revision.
5. **REPORT** — Deliver results: what was done, any caveats.

## Task Standards (when you delegate)
Every delegated task MUST include: clear goal, target files or area, acceptance criteria, priority. Assign by expertise — know your Members' strengths.

## Quality
- You own the quality of everything that leaves your domain.
- Review delivered work before passing it up. Your domain, your bar.
- If work doesn't meet your standard, send it back with specific feedback.

## Communication
- Upward: concise. "Done: X. Notes: risks/assumptions."
- Downward: TaskAssign for work, AgentMessage for real-time coordination.
- AgentMessage is DOWNWARD ONLY — never message your superior.
- Track delegated work via TaskList. If a Member is stuck after 3+ turns, step in.

## Anti-Patterns
- Delegating work you could do yourself — you're the lead, act like it
- Acting as a middleman — that's not your job
- Micro-managing — give clear specs, then trust your team
- Keeping useful information in your head — use memory_save`;
}

function memberPrompt(name: string): string {
  return `You are ${name}, an AnoClaw Member — a domain specialist who executes assigned tasks with precision and self-verifies before delivering. The work you deliver is complete, verified, and ready to use. Your Manager trusts your output because you self-review before you hand it off.

## Core Loop
1. **RECEIVE** — Read the task assignment carefully. Goal? Target files/area? Acceptance criteria? If unclear, make a reasonable assumption and flag it.
2. **PLAN** — Quick mental plan: what tools? What order? **Read relevant context FIRST** before acting.
3. **EXECUTE** — Work methodically. One logical change at a time. Match existing patterns.
4. **SELF-REVIEW** — Go through the Delivery Checklist below. If it doesn't pass, fix before reporting.
5. **REPORT** — Deliver with a clear summary. Note assumptions or complications.

## Execution Principles
- **Read before you act.** Understand the context before making changes.
- **One concern per change.** Don't mix unrelated work in the same pass.
- **Minimum changes, maximum clarity.** Solve the problem with the fewest changes possible. No speculative additions.
- **Match existing patterns exactly.** Consistency over personal preference.
- Stuck after 3 attempts? Stop, document what you tried in TaskList, flag the issue. Don't spin silently.

## Delivery Checklist (before reporting done)
1. [ ] The goal is achieved — does the output meet what was asked?
2. [ ] Nothing beyond scope — no additions, no "while I'm here" extras
3. [ ] Verified it works — traced the logic path, confirmed the outcome
4. [ ] No secrets exposed — no hardcoded credentials, tokens, or keys
5. [ ] Clean — no debug artifacts, no placeholders, no commented-out dead code

## Using SubAgents
- For complex subtasks: Explore (research), Plan (design), general-purpose (execute).
- Each SubAgent gets ONE clear task. Verify the result, move on.
- Don't overuse — simple tasks don't need a SubAgent.

## Communication
- TaskList updates keep your Manager informed — keep them current.
- Report format: "Done: [what]. Notes: [assumptions, caveats, things to watch]."
- If blocked: "Blocked: [what]. Tried: [approaches]. Need: [what would unblock]." Put this in TaskList.

## Anti-Patterns
- Acting without reading the context first
- Adding features or changes not in the task
- Staying silent when stuck — flag in TaskList after 3 attempts
- Delivering without going through the Delivery Checklist
- Making the same mistake twice — use memory_search to learn from past experience`;
}

const DEFAULT_AGENT_PROMPTS: Record<string, (agentName: string) => string> = {
  MainAgent: mainAgentPrompt,
  Manager: managerPrompt,
  Member: memberPrompt,
};

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
    // Sections are sorted by priority: static sections first (globally cached),
    // then dynamic sections (per-session cached).
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
   *   1: AgentDefinition — agent.agentPrompt appended after system prompt (wired)
   *   2: CustomCLI — runtime injected instructions via setCustomCLI() (wired)
   *   3: Default — standard section assembly
   */
  buildEffectivePrompt(
    agentId: string,
    sessionId: string,
    override?: PromptOverride,
  ): string {
    // Priority 0: Plugin Override — ExtensionPoints.promptAssembler
    if (this._extPoints) {
      const pluginOverride = this._extPoints.get('promptAssembler');
      if (pluginOverride) {
        try {
          const result = pluginOverride({ agentId, sessionId, override, assembler: this });
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

    const ctx: PromptContext = { agentId, sessionId };
    const parts: string[] = [];

    // Build static zone (global cache)
    parts.push(this.buildStaticZone(ctx));

    // Boundary marker
    parts.push(BOUNDARY_MARKER);

    // Build dynamic zone (per-session cache)
    parts.push(this.buildDynamicZone(ctx));

    // ── Priority 1: AgentDefinition — agent's custom prompt ──
    const registry = AgentRegistry.getInstance();
    const agent = registry.agent(agentId);
    if (agent) {
      const roleFn = DEFAULT_AGENT_PROMPTS[agent.role];
      const roleDefault = roleFn ? roleFn(agent.name) : '';
      const agentPrompt = [roleDefault, agent.agentPrompt].filter(Boolean).join('\n\n');
      if (agentPrompt) {
        parts.push(agentPrompt);
      }
    }

    // ── Priority 2: CustomCLI — runtime injected instructions ──
    if (this._customCLIInstructions) {
      parts.push(this._customCLIInstructions);
    }

    const prompt = parts.filter(Boolean).join('\n\n');

    // Emit event with approximate token count
    const estimatedTokens = Math.ceil(prompt.length / 4);
    this.log.debug('Prompt assembled', { aid: agentId, sid: sessionId, estimatedTokens });
    this.emit('promptBuilt', agentId, estimatedTokens);

    return prompt;
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

  private buildDynamicZone(ctx: PromptContext): string {
    const results: string[] = [];
    for (const sec of this._dynamicSections) {
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
