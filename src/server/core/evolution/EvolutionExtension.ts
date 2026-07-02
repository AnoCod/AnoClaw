/**
 * EvolutionExtension — Extension wrapper for the self-evolution system.
 *
 * Wires all 6 modules via TypedEventBus:
 *   M1: tool buffer → pattern detection → auto SKILL.md generation
 *   M2: keyword extraction → persist to session metadata
 *   M3: stats collection + periodic auto-flush (5 min)
 *   M4: auto-tag sessions → persist to metadata → frontend tag chips
 *   M5: quality score index updates (periodic)
 *   M6: none directly (triggered via HTTP route from Settings page)
 */

import type { Extension } from '../extensible/Extension.js';
import { EvolutionManager } from './EvolutionManager.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { SessionManager } from '../session/index.js';
import { createLogger } from '../logger.js';

/** Auto-flush interval: 5 minutes */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** Pattern → skill threshold */
const SKILL_CREATE_THRESHOLD = 3;

export class EvolutionExtension implements Extension {
  readonly id = 'evolution';
  readonly name = 'Evolution System';
  readonly dependencies: string[] = [];

  private _unsubToolCompleted: (() => void) | null = null;
  private _unsubLoopCompleted: (() => void) | null = null;
  private _unsubKeywordTurn: (() => void) | null = null;
  private _unsubSkillLoaded: (() => void) | null = null;
  private _unsubMemoryRetrieved: (() => void) | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _log = createLogger('anochat.evolution');

  /** Per-session tool call buffer for M1 pattern detection */
  private _toolBuffers = new Map<string, Array<{ tool: string; params: string[] }>>();

  // ── M1: Tool sequence tracking ──

  private _addToolToBuffer(sessionId: string, toolName: string): void {
    if (!this._toolBuffers.has(sessionId)) {
      this._toolBuffers.set(sessionId, []);
    }
    const buf = this._toolBuffers.get(sessionId)!;
    // Allow up to 3 consecutive same-tool calls before deduplicating.
    // ReAct loops often call Read→Read→Read→Edit→Bash; same-tool runs are normal.
    let consecutive = 0;
    for (let i = buf.length - 1; i >= 0 && buf[i].tool === toolName; i--) {
      consecutive++;
    }
    if (consecutive >= 3) return;
    buf.push({ tool: toolName, params: [] });
  }

  private async _flushToolBuffer(sessionId: string): Promise<void> {
    const buf = this._toolBuffers.get(sessionId);
    if (!buf || buf.length < 2) {
      this._toolBuffers.delete(sessionId);
      return;
    }
    const mgr = EvolutionManager.getInstance();
    const sig = buf.map(b => ({ tool: b.tool, params: b.params }));
    await mgr.patterns.recordToolSequence(sessionId, sig, 0);
    this._toolBuffers.delete(sessionId);

    // Check if any pattern reached the skill-creation threshold
    await this._checkSkillCandidates();
  }

  private async _checkSkillCandidates(): Promise<void> {
    const mgr = EvolutionManager.getInstance();
    const candidates = mgr.patterns.getSkillCandidates(SKILL_CREATE_THRESHOLD);
    for (const pattern of candidates) {
      const skillName = await mgr.generateSkillFromPattern(pattern.patternId);
      if (skillName) {
        this._log.info('Auto-generated skill from pattern', {
          patternId: pattern.patternId,
          skillName,
          count: pattern.count,
        });
      }
    }
  }

  async start(): Promise<void> {
    const mgr = EvolutionManager.getInstance();
    await mgr.init();

    // ── M3: Stats collector + M1: tool buffer ──
    this._unsubToolCompleted = TypedEventBus.on('tool:execution_completed', (payload) => {
      mgr.recordToolCall(payload.toolName, payload.success, payload.tokensUsed, payload.durationMs);
      this._addToolToBuffer(payload.sessionId, payload.toolName);
    });

    // ── M3: Skill loading stats ──
    this._unsubSkillLoaded = TypedEventBus.on('skill:loaded', (payload) => {
      for (const name of payload.skillNames) {
        mgr.stats.recordSkillLoad(name);
      }
    });

    // ── M3: Memory retrieval stats ──
    this._unsubMemoryRetrieved = TypedEventBus.on('memory:retrieved', (payload) => {
      for (const name of payload.memoryNames) {
        mgr.stats.recordMemoryRetrieval(name);
      }
    });

    // ── M4 + M1 flush on loop completion ──
    this._unsubLoopCompleted = TypedEventBus.on('loop:completed', async (payload) => {
      mgr.tagger.addTag(payload.sessionId, 'completed', 'auto', 0.9);
      await this._flushToolBuffer(payload.sessionId);
      this._persistTags(payload.sessionId, mgr);
    });

    // ── M2: Keyword extraction → persist to session metadata ──
    this._unsubKeywordTurn = TypedEventBus.on('loop:keyword_turn', (payload) => {
      const result = mgr.keywords.extract(
        payload.userMessages,
        payload.assistantMessages,
        Math.max(0, payload.turnNumber - 10),
        payload.turnNumber,
      );
      // Persist keywords to session metadata
      try {
        const session = SessionManager.getInstance().session(payload.sessionId);
        if (session) {
          session.setMetadata('evolutionKeywords', {
            userKeywords: result.userKeywords,
            llmKeywords: result.llmKeywords,
            summary: result.summary,
            turnRange: result.turnRange,
          });
        }
      } catch { /* non-critical */ }

      // Auto-tag session based on extracted keywords
      const domainTags = this._domainTagsFromKeywords(result.userKeywords, result.llmKeywords);
      for (const tag of domainTags) {
        mgr.tagger.addTag(payload.sessionId, tag, 'auto', 0.7);
      }
      this._persistTags(payload.sessionId, mgr);
    });

    // ── M3: Periodic auto-flush ──
    this._flushTimer = setInterval(() => {
      mgr.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);

    this._log.info('Evolution extension started — M1 tool patterns enabled with threshold', { threshold: SKILL_CREATE_THRESHOLD });
  }

  async stop(): Promise<void> {
    const mgr = EvolutionManager.getInstance();
    await mgr.flush();

    this._unsubToolCompleted?.();
    this._unsubToolCompleted = null;
    this._unsubLoopCompleted?.();
    this._unsubLoopCompleted = null;
    this._unsubKeywordTurn?.();
    this._unsubKeywordTurn = null;
    this._unsubSkillLoaded?.();
    this._unsubSkillLoaded = null;
    this._unsubMemoryRetrieved?.();
    this._unsubMemoryRetrieved = null;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    this._toolBuffers.clear();
    this._log.info('Evolution extension stopped');
  }

  isRunning(): boolean {
    return this._unsubToolCompleted !== null;
  }

  // ── M4 helpers ──

  private _persistTags(sessionId: string, mgr: EvolutionManager): void {
    const tags = mgr.tagger.toJSON(sessionId);
    if (tags.length > 0) {
      try {
        const session = SessionManager.getInstance().session(sessionId);
        if (session) {
          session.setMetadata('evolutionTags', tags);
        }
      } catch { /* non-critical */ }
    }
  }

  /** Derive domain tags from extracted keywords (heuristic). */
  private _domainTagsFromKeywords(userKw: string[], llmKw: string[]): string[] {
    const all = [...new Set([...userKw, ...llmKw.map(k => k.toLowerCase())])];
    const tags: string[] = [];
    const domainMap: Array<{ keywords: string[]; tag: string }> = [
      { keywords: ['frontend', 'css', 'html', 'ui', 'layout', 'theme', 'responsive', 'button', 'color', 'font', 'animation'], tag: 'frontend' },
      { keywords: ['backend', 'api', 'server', 'database', 'auth', 'middleware', 'route', 'endpoint', 'websocket'], tag: 'backend' },
      { keywords: ['bug', 'fix', 'error', 'issue', 'broken', 'crash', 'regression'], tag: 'bug-fix' },
      { keywords: ['refactor', 'clean', 'restructure', 'split', 'extract', 'rename'], tag: 'refactor' },
      { keywords: ['test', 'spec', 'assert', 'mock', 'coverage', 'vitest'], tag: 'testing' },
      { keywords: ['doc', 'readme', 'comment', 'documentation', 'markdown'], tag: 'documentation' },
      { keywords: ['security', 'vulnerability', 'xss', 'injection', 'auth', 'permission'], tag: 'security' },
      { keywords: ['performance', 'slow', 'optimize', 'latency', 'cache', 'bundle'], tag: 'performance' },
      { keywords: ['deploy', 'ci', 'cd', 'pipeline', 'build', 'release', 'docker'], tag: 'devops' },
      { keywords: ['config', 'setting', 'env', 'variable', 'key', 'secret'], tag: 'configuration' },
    ];
    for (const { keywords, tag } of domainMap) {
      if (keywords.some(kw => all.some(a => a.includes(kw)))) {
        tags.push(tag);
        if (tags.length >= 3) break; // max 3 domain tags
      }
    }
    return tags;
  }
}
