// SkillManager.ts — Singleton skill registry with Claude Code-compatible features
// Multi-source loading: Project (highest) > User > Plugin > Builtin (lowest).
// Semantic matching via when_to_use, conditional activation via paths glob patterns.
// Integrates with PromptAssembler for cache invalidation.
//
// Skill usage tracking: useCount + lastUsedAt persisted to data/skill-usage.json.
// Staleness formula: daysSinceLastUse / (1 + log2(1 + useCount)).
//   STALE  (>60 days + useCount<3) → demoted in prompts
//   ARCHIVE (>180 days + useCount<1) → excluded from prompts

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, Dirent } from 'fs';
import * as path from 'path';
import { writablePath } from '../../infra/WritablePath.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { Skill, SkillSource, sourceWeight } from './Skill.js';
import { generateSkillFromTools, generateSkillFromTranscript, SkillGenLLMOptions } from './SkillFromTools.js';
import { PromptAssembler } from '../prompt/PromptAssembler.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { createLogger } from '../logger.js';

interface SkillEntry { skill: Skill; source: SkillSource; }

interface SkillUsage {
  useCount: number;
  lastUsedAt: string; // ISO timestamp
}

interface SkillUsageFile {
  version: 1;
  updatedAt: string;
  skills: Record<string, SkillUsage>;
}

export type SkillStaleness = 'fresh' | 'stale' | 'archived';

/** Divisor to normalize raw keyword score to 0–1 range. */
const KEYWORD_SCORE_DIVISOR = 200;

export class SkillManager extends EventEmitter {
  private static _instance: SkillManager;

  static getInstance(): SkillManager {
    if (!this._instance) this._instance = new SkillManager();
    return this._instance;
  }
  static resetInstance(): void { this._instance = undefined as unknown as SkillManager; }

  private _skills: Map<string, SkillEntry> = new Map();
  private _loadedDirs: Array<{ dir: string; source: SkillSource }> = [];
  private _disabledSkills: Set<string> = new Set();
  private _disabledSkillsPath: string;

  // Skill usage tracking
  private _skillUsage: Map<string, SkillUsage> = new Map();
  private _skillUsagePath: string;
  private _usageLoaded = false;

  private constructor() {
    super();
    this._disabledSkillsPath = writablePath('data', 'disabled-skills.json');
    this._skillUsagePath = writablePath('data', 'skill-usage.json');
    this._loadDisabledSkillsSync();
    this._loadUsageSync();
  }

  /** Total loaded skill count */
  get count(): number { return this._skills.size; }

  // ─── Disabled skills persistence ──────────────────────────

  private _loadDisabledSkillsSync(): void {
    try {
      if (existsSync(this._disabledSkillsPath)) {
        const raw = readFileSync(this._disabledSkillsPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) this._disabledSkills = new Set(data);
      }
    } catch { this._disabledSkills = new Set(); }
  }

  private async _saveDisabledSkills(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this._disabledSkillsPath), { recursive: true });
      await fs.writeFile(this._disabledSkillsPath, JSON.stringify([...this._disabledSkills], null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  // ─── Skill usage persistence ──────────────────────────────

  private _loadUsageSync(): void {
    try {
      if (existsSync(this._skillUsagePath)) {
        const raw = readFileSync(this._skillUsagePath, 'utf-8');
        const data: SkillUsageFile = JSON.parse(raw);
        if (data?.skills) {
          for (const [name, usage] of Object.entries(data.skills)) {
            if (typeof usage.useCount === 'number' && typeof usage.lastUsedAt === 'string') {
              this._skillUsage.set(name, { useCount: usage.useCount, lastUsedAt: usage.lastUsedAt });
            }
          }
        }
      }
    } catch { this._skillUsage = new Map(); }
    this._usageLoaded = true;
  }

  private async _saveUsage(): Promise<void> {
    const skills: Record<string, SkillUsage> = {};
    for (const [name, usage] of this._skillUsage) {
      skills[name] = usage;
    }
    const data: SkillUsageFile = { version: 1, updatedAt: new Date().toISOString(), skills };
    try {
      await fs.mkdir(path.dirname(this._skillUsagePath), { recursive: true });
      await fs.writeFile(this._skillUsagePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  // ─── Usage tracking ───────────────────────────────────────

  /**
   * Record that a skill was used. Increments useCount and updates lastUsedAt.
   * Persists to data/skill-usage.json asynchronously.
   */
  recordUsage(skillName: string): void {
    if (!this._usageLoaded) this._loadUsageSync();
    const existing = this._skillUsage.get(skillName);
    if (existing) {
      existing.useCount++;
      existing.lastUsedAt = new Date().toISOString();
    } else {
      this._skillUsage.set(skillName, { useCount: 1, lastUsedAt: new Date().toISOString() });
    }
    this._saveUsage().catch(() => {});
  }

  /** Get raw usage stats for a skill. */
  getUsage(skillName: string): SkillUsage | undefined {
    if (!this._usageLoaded) this._loadUsageSync();
    return this._skillUsage.get(skillName);
  }

  /**
   * Compute staleness score: daysSinceLastUse / (1 + log2(1 + useCount)).
   * Higher = more stale. Returns 0 for skills with no usage data.
   */
  getStaleness(skillName: string): number {
    const usage = this._skillUsage.get(skillName);
    if (!usage) return 0;
    const lastUsed = new Date(usage.lastUsedAt).getTime();
    if (isNaN(lastUsed)) return 0;
    const daysSince = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
    if (daysSince <= 0) return 0;
    const divisor = 1 + Math.log2(1 + usage.useCount);
    return daysSince / divisor;
  }

  /**
   * Return staleness classification for a skill.
   *   - STALE:  >60 days since last use AND useCount < 3
   *   - ARCHIVE: >180 days since last use AND useCount < 1
   */
  getStalenessClass(skillName: string): SkillStaleness {
    const usage = this._skillUsage.get(skillName);
    if (!usage) return 'fresh';
    const lastUsed = new Date(usage.lastUsedAt).getTime();
    if (isNaN(lastUsed)) return 'fresh';
    const daysSince = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);

    if (daysSince > 180 && usage.useCount < 1) return 'archived';
    if (daysSince > 60 && usage.useCount < 3) return 'stale';
    return 'fresh';
  }

  /** Is the skill stale (demoted in prompts)? */
  isStale(skillName: string): boolean {
    return this.getStalenessClass(skillName) === 'stale';
  }

  /** Is the skill archived (excluded from prompts)? */
  isArchived(skillName: string): boolean {
    return this.getStalenessClass(skillName) === 'archived';
  }

  // ─── Loading (multi-source) ───────────────────────────────

  /**
   * Load skills from a directory recursively. Supports:
   *   - nested: dir/<name>/SKILL.md (standard)
   *   - flat: dir/<name>.md (deprecated, auto-migrate recommendation logged)
   */
  async loadFromDirectory(dir: string, source: SkillSource = SkillSource.Project): Promise<void> {
    this._loadedDirs.push({ dir, source });
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; } // dir doesn't exist — graceful

    for (const entry of entries) {
      try {
        if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          const skillMd = path.join(dir, entry.name, 'SKILL.md');
          try { await fs.access(skillMd); }
          catch { continue; } // no SKILL.md — skip
          const skill = await Skill.fromMarkdown(skillMd, source);
          this._register(skill, source);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(dir, entry.name);
          const skill = await Skill.fromMarkdown(filePath, source);
          this._register(skill, source);
          createLogger('anochat.core').warn('Flat skill format', {
            skill: entry.name,
            hint: `Migrate to ${entry.name.replace('.md', '')}/SKILL.md`,
          });
        }
      } catch (err: unknown) {
        createLogger('anochat.core').warn('Skill load failed', { name: entry.name, error: (err as Error).message });
      }
    }
  }

  /** Load all built-in user-level skills from ~/.anoclaw/skills/ */
  async loadUserSkills(): Promise<void> {
    const home = process.env.USERPROFILE || process.env.HOME || '~';
    const userDir = path.join(home, '.anoclaw', 'skills');
    await this.loadFromDirectory(userDir, SkillSource.User);
  }

  /** Load skills from a plugin's skills/ subdirectory */
  async loadFromPlugin(pluginPath: string): Promise<void> {
    const skillsDir = path.join(pluginPath, 'skills');
    await this.loadFromDirectory(skillsDir, SkillSource.Plugin);
  }

  /** Reload all previously loaded directories */
  async reloadAll(): Promise<void> {
    const dirs = [...this._loadedDirs];
    this._skills.clear();
    this._loadedDirs = [];
    for (const { dir, source } of dirs) {
      await this.loadFromDirectory(dir, source);
    }
    PromptAssembler.getInstance().clearAllCaches();
    this.emit('skillsReloaded', this._skills.size);
    TypedEventBus.emit('skill:changed', { action: 'reloaded', name: '*' });
  }

  // ─── Registration (priority-aware) ────────────────────────

  private _register(skill: Skill, source: SkillSource): void {
    const existing = this._skills.get(skill.name());
    if (existing) {
      if (sourceWeight(source) >= sourceWeight(existing.source)) {
        this.emit('skillUnloaded', existing.skill.name(), existing.source);
        this._skills.set(skill.name(), { skill, source });
        this.emit('skillLoaded', skill.name(), source);
      }
      return; // lower priority → skip
    }
    this._skills.set(skill.name(), { skill, source });
    this.emit('skillLoaded', skill.name(), source);
  }

  // ─── CRUD ─────────────────────────────────────────────────

  private _getProjectSkillsDir(): string {
    for (const { dir, source } of this._loadedDirs) {
      if (source === SkillSource.Project) return dir;
    }
    return path.resolve(process.cwd(), 'skills');
  }

  async createSkill(name: string, description: string, content: string, skillsDir?: string): Promise<void> {
    const dir = skillsDir ?? this._getProjectSkillsDir();
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const skillDir = path.join(dir, safeName);
    const filePath = path.join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });

    const fm = ['---', `name: "${name}"`, `description: "${description}"`, '---', ''].join('\n');
    await fs.writeFile(filePath, fm + content, 'utf-8');

    const skill = Skill.fromContent(fm + content, filePath, SkillSource.Project);
    this._register(skill, SkillSource.Project);
    if (!this._loadedDirs.find(d => d.dir === dir)) this._loadedDirs.push({ dir, source: SkillSource.Project });
    PromptAssembler.getInstance().clearAllCaches();
    TypedEventBus.emit('skill:changed', { action: 'created', name });
  }

  async deleteSkill(name: string): Promise<void> {
    const entry = this._skills.get(name);
    if (!entry) throw new Error(`Skill "${name}" not found`);
    const fp = entry.skill.filePath();
    if (fp) await fs.rm(path.dirname(fp), { recursive: true, force: true });
    this._skills.delete(name);
    this._disabledSkills.delete(name);
    this._skillUsage.delete(name);
    await this._saveUsage();
    PromptAssembler.getInstance().clearAllCaches();
    TypedEventBus.emit('skill:changed', { action: 'deleted', name });
  }

  async toggleSkill(name: string, enabled: boolean): Promise<void> {
    if (enabled) this._disabledSkills.delete(name);
    else this._disabledSkills.add(name);
    await this._saveDisabledSkills();
    TypedEventBus.emit('skill:changed', { action: 'updated', name });
  }

  isEnabled(name: string): boolean { return !this._disabledSkills.has(name); }

  // ─── Querying ─────────────────────────────────────────────

  allSkills(): Skill[] {
    return [...this._skills.values()].map(e => e.skill).sort((a, b) => a.name().localeCompare(b.name()));
  }

  getSkill(name: string): Skill | undefined { return this._skills.get(name)?.skill; }

  /**
   * Skills available for a specific agent. Filters out archived skills.
   * Stale skills are still included but sorted to the end.
   */
  skillsForAgent(agentId: string): Skill[] {
    const all = this.allSkills();
    let filtered: Skill[];
    try {
      const agent = AgentRegistry.getInstance().agent(agentId);
      if (agent) {
        const enabled = agent.enabledSkills();
        if (enabled?.length > 0) {
          const set = new Set(enabled);
          filtered = all.filter(s => set.has(s.name()));
        } else {
          filtered = all;
        }
      } else {
        filtered = all;
      }
    } catch { filtered = all; }

    // Exclude archived, sort by useCount desc, push stale to end
    return filtered
      .filter(s => !this.isArchived(s.name()))
      .sort((a, b) => {
        const aStale = this.isStale(a.name()) ? 1 : 0;
        const bStale = this.isStale(b.name()) ? 1 : 0;
        if (aStale !== bStale) return aStale - bStale;
        // Sort by useCount descending (most-used first)
        const aCount = this._skillUsage.get(a.name())?.useCount ?? 0;
        const bCount = this._skillUsage.get(b.name())?.useCount ?? 0;
        return bCount - aCount;
      });
  }

  /**
   * Find skills matching a user message. Uses hybrid semantic + keyword scoring:
   *   - Embedding cosine similarity (0.7 weight) via EmbeddingService (ONNX all-MiniLM-L6-v2)
   *   - Keyword matching (0.3 weight) via triggers / when_to_use / name
   *   - Falls back to keyword-only when embedding model is unavailable
   *
   * Stale skills get a score penalty. Archived skills are excluded.
   */
  async matchingSkills(userMessage: string): Promise<Skill[]> {
    if (!userMessage) return [];
    const lower = userMessage.toLowerCase();
    const enabled = [...this._skills.values()]
      .filter(e => this.isEnabled(e.skill.name()))
      .filter(e => !this.isArchived(e.skill.name()));

    // ── Lazy-load embedding service ──────────────────────────
    let userEmbedding: Float32Array | null = null;
    let skillEmbeddings: (Float32Array | null)[] = [];
    let embReady = false;

    try {
      const { EmbeddingService } = await import('../memory/embedding/EmbeddingService.js');
      const emb = EmbeddingService.getInstance();
      if (emb.isReady()) {
        userEmbedding = await emb.embed(userMessage);
        if (userEmbedding.every(v => v === 0)) userEmbedding = null;
        if (userEmbedding) {
          embReady = true;
          const texts: Array<{ idx: number; text: string }> = [];
          enabled.forEach((e, i) => {
            const t = (e.skill.whenToUse() + ' ' + e.skill.description()).trim();
            if (t) texts.push({ idx: i, text: t });
          });
          if (texts.length > 0) {
            const batchResults = await emb.embedBatch(texts.map(t => t.text));
            skillEmbeddings = new Array(enabled.length).fill(null);
            texts.forEach(({ idx }, bi) => {
              const vec = batchResults[bi];
              skillEmbeddings[idx] = vec.every(v => v === 0) ? null : vec;
            });
          }
        }
      }
    } catch { /* embedding unavailable — fall through to keyword-only */ }

    // ── Score each skill ─────────────────────────────────────
    const scored: Array<{ skill: Skill; score: number }> = [];
    let cosineSim: ((a: Float32Array, b: Float32Array) => number) | null = null;
    if (embReady) {
      const { EmbeddingService: EmbSvc } = await import('../memory/embedding/EmbeddingService.js');
      cosineSim = EmbSvc.cosineSimilarity.bind(EmbSvc);
    }

    for (let i = 0; i < enabled.length; i++) {
      const s = enabled[i].skill;
      let kwScore = this._keywordScore(s, lower);
      let embScore = 0;

      if (cosineSim && userEmbedding && skillEmbeddings[i]) {
        embScore = cosineSim(userEmbedding, skillEmbeddings[i]!);
      }

      // Staleness penalty on keyword score
      if (this.isStale(s.name())) kwScore = kwScore / 2;

      const finalScore = embReady
        ? (0.7 * embScore + 0.3 * kwScore)
        : kwScore;

      if (finalScore > 0) scored.push({ skill: s, score: finalScore });
    }

    const result = scored.sort((a, b) => b.score - a.score).map(m => m.skill);
    return result;
  }

  /**
   * Match skills AND record usage. This is the side-effectful variant —
   * call this from user-initiated flows (chat, tool execution).
   * For read-only queries, call matchingSkills() directly.
   */
  async matchAndTrack(userMessage: string): Promise<Skill[]> {
    const result = await this.matchingSkills(userMessage);
    for (const s of result) this.recordUsage(s.name());
    return result;
  }

  /** Keyword-based score normalized 0–1. Used standalone or blended with embedding score. */
  private _keywordScore(skill: Skill, lower: string): number {
    let raw = 0;

    // Tier 1: Keyword triggers
    for (const t of skill.triggers()) {
      if (t && lower.includes(t.toLowerCase())) raw = Math.max(raw, t.length * 10);
    }
    // Tier 2: when_to_use phrases + words
    const whenToUse = skill.whenToUse();
    if (whenToUse) {
      const phrases = whenToUse.match(/"([^"]+)"/g) ?? [];
      for (const p of phrases) {
        const clean = p.replace(/"/g, '').toLowerCase();
        if (lower.includes(clean)) raw = Math.max(raw, clean.length * 3);
      }
      const words = whenToUse.toLowerCase().split(/[\s,;]+/);
      for (const w of words) {
        if (w.length > 3 && lower.includes(w)) raw = Math.max(raw, w.length);
      }
    }
    // Tier 3: Name match
    if (skill.name().length > 3 && lower.includes(skill.name().toLowerCase())) {
      raw = Math.max(raw, skill.name().length * 0.5);
    }

    return Math.min(raw / KEYWORD_SCORE_DIVISOR, 1);
  }

  // ─── User-level skills directory support ──────────────────

  /** Get path to user-level skills dir (~/.anoclaw/skills/) */
  getUserSkillsDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || '~';
    return path.join(home, '.anoclaw', 'skills');
  }

  // ─── Legacy API compat (used by routes + tests) ──────────

  /** Get the full body of a specific skill (used by SkillExecuteRoute) */
  loadSkillBody(name: string): string | null {
    const skill = this.getSkill(name);
    return skill?.body() ?? null;
  }

  /** Update an existing skill's content on disk + in memory */
  async updateSkill(name: string, description: string, content: string): Promise<void> {
    const entry = this._skills.get(name);
    if (!entry) throw new Error(`Skill "${name}" not found`);
    const fp = entry.skill.filePath();
    if (!fp) throw new Error(`Skill "${name}" has no file path`);
    const fm = ['---', `name: "${name}"`, `description: "${description}"`, '---', ''].join('\n');
    await fs.writeFile(fp, fm + content, 'utf-8');
    const skill = Skill.fromContent(fm + content, fp, entry.source);
    this._skills.set(name, { skill, source: entry.source });
    PromptAssembler.getInstance().clearAllCaches();
    TypedEventBus.emit('skill:changed', { action: 'updated', name });
  }

  /** All enabled skills (filtered by disabled set, excludes archived) */
  allEnabledSkills(): Skill[] {
    return this.allSkills()
      .filter(s => this.isEnabled(s.name()))
      .filter(s => !this.isArchived(s.name()));
  }

  /**
   * Auto-generate a skill from conversation patterns.
   * Tries LLM-based semantic generation first when llmOptions are provided.
   * Falls back to rule-based detection otherwise.
   */
  async autoGenerateSkill(
    transcript: unknown[],
    toolCalls?: Array<{ name: string; result?: string }>,
    llmOptions?: SkillGenLLMOptions,
  ): Promise<string | null> {
    // Try LLM-based generation when config is available
    if (llmOptions?.apiUrl && llmOptions?.apiKey && llmOptions?.model) {
      const result = await generateSkillFromTranscript(
        transcript,
        toolCalls ?? [],
        llmOptions,
        path.resolve(process.cwd(), 'skills'),
      );
      if (result) {
        await this.loadFromDirectory(path.resolve(process.cwd(), 'skills'), SkillSource.Project);
        PromptAssembler.getInstance().clearAllCaches();
        this.emit('skillAutoGenerated', result.skillName);
        return result.skillName;
      }
      return null;
    }

    // Fallback to legacy rule-based (returns null for most patterns without LLM)
    const skillName = await generateSkillFromTools(
      transcript, toolCalls,
      path.resolve(process.cwd(), 'skills'),
      async (name) => {
        await this.loadFromDirectory(path.resolve(process.cwd(), 'skills'), SkillSource.Project);
        PromptAssembler.getInstance().clearAllCaches();
        this.emit('skillAutoGenerated', name);
      },
    );
    return skillName;
  }

  // ─── Count / Diagnostics ──────────────────────────────────

  skillSources(): Map<string, SkillSource> {
    const m = new Map<string, SkillSource>();
    for (const [name, entry] of this._skills) m.set(name, entry.source);
    return m;
  }

  /** Get all skill usage data for diagnostics. */
  getAllUsage(): Map<string, SkillUsage> {
    if (!this._usageLoaded) this._loadUsageSync();
    return new Map(this._skillUsage);
  }
}
