/**
 * StatsCollector — M3: collect usage statistics by subscribing to events.
 *
 * Records tool call counts, skill loads, and memory retrievals through
 * direct method calls (wired via TypedEventBus or called from hooks).
 * Stats are persisted to EvolutionStore for cross-session accumulation.
 *
 * All counters are O(1) in-memory. flush() writes to disk atomically.
 */

import type { EvolutionStore } from '../storage/EvolutionStore.js';
import type {
  ToolStats,
  SkillStats,
  MemoryStats,
} from '../../../../shared/types/evolution.js';
import { createLogger } from '../../logger.js';

export interface ToolStatRecord {
  callCount: number;
  successCount: number;
  totalTokens: number;
  totalDurationMs: number;
  avgTokens: number;
  p50Tokens: number;
  p95Tokens: number;
  avgDurationMs: number;
  lastUsedAt: string;
}

export interface SkillStatRecord {
  loadCount: number;
  matchL0Count: number;
  execReferencedCount: number;
  patchCount: number;
  lastUsedAt: string;
}

export interface MemoryStatRecord {
  retrievalCount: number;
  clickThroughCount: number;
  clickThroughRate: number;
  lastRetrievedAt: string;
}

export interface StatsSnapshot {
  tools: Record<string, ToolStatRecord>;
  skills: Record<string, SkillStatRecord>;
  memories: Record<string, MemoryStatRecord>;
}

export class StatsCollector {
  private _store: EvolutionStore;
  private _tools: Record<string, ToolStatRecord> = {};
  private _skills: Record<string, SkillStatRecord> = {};
  private _memories: Record<string, MemoryStatRecord> = {};
  private _log = createLogger('anochat.evolution.stats');

  constructor(store: EvolutionStore) {
    this._store = store;
  }

  // ── Tool stats ──

  /** Record a tool call execution. */
  recordToolCall(toolName: string, success: boolean, tokensUsed: number, durationMs: number): void {
    const now = new Date().toISOString();
    if (!this._tools[toolName]) {
      this._tools[toolName] = {
        callCount: 0, successCount: 0, totalTokens: 0, totalDurationMs: 0,
        avgTokens: 0, p50Tokens: 0, p95Tokens: 0, avgDurationMs: 0, lastUsedAt: now,
      };
    }
    const t = this._tools[toolName];
    t.callCount++;
    if (success) t.successCount++;
    t.totalTokens += tokensUsed;
    t.totalDurationMs += durationMs;
    t.avgTokens = Math.round(t.totalTokens / t.callCount);
    t.avgDurationMs = Math.round(t.totalDurationMs / t.callCount);
    // Approximate: p50 = avg * 0.5, p95 = avg * 2 (no raw per-call data to compute true percentiles)
    t.p50Tokens = Math.round(t.avgTokens * 0.5);
    t.p95Tokens = Math.round(t.avgTokens * 2);
    t.lastUsedAt = now;
  }

  /** Get copy of tool stats. */
  getToolStats(): Record<string, ToolStatRecord> {
    return { ...this._tools };
  }

  // ── Skill stats ──

  /** Record a skill being loaded into the prompt path. */
  recordSkillLoad(skillName: string): void {
    const now = new Date().toISOString();
    if (!this._skills[skillName]) {
      this._skills[skillName] = {
        loadCount: 0, matchL0Count: 0, execReferencedCount: 0, patchCount: 0, lastUsedAt: now,
      };
    }
    this._skills[skillName].loadCount++;
    this._skills[skillName].lastUsedAt = now;
  }

  /** Record a skill being referenced during execution. */
  recordSkillReference(skillName: string): void {
    if (!this._skills[skillName]) {
      this._skills[skillName] = {
        loadCount: 0, matchL0Count: 0, execReferencedCount: 0, patchCount: 0, lastUsedAt: new Date().toISOString(),
      };
    }
    this._skills[skillName].execReferencedCount++;
  }

  /** Get copy of skill stats. */
  getSkillStats(): Record<string, SkillStatRecord> {
    return { ...this._skills };
  }

  // ── Memory stats ──

  /** Record a memory being retrieved via search. */
  recordMemoryRetrieval(memoryName: string): void {
    if (!this._memories[memoryName]) {
      this._memories[memoryName] = {
        retrievalCount: 0, clickThroughCount: 0, clickThroughRate: 0, lastRetrievedAt: '',
      };
    }
    this._memories[memoryName].retrievalCount++;
    this._memories[memoryName].lastRetrievedAt = new Date().toISOString();
    this._updateMemoryRate(memoryName);
  }

  /** Record a memory being actually read (click-through). */
  recordMemoryClick(memoryName: string): void {
    if (!this._memories[memoryName]) {
      this._memories[memoryName] = {
        retrievalCount: 0, clickThroughCount: 0, clickThroughRate: 0, lastRetrievedAt: '',
      };
    }
    this._memories[memoryName].clickThroughCount++;
    this._updateMemoryRate(memoryName);
  }

  private _updateMemoryRate(name: string): void {
    const m = this._memories[name];
    if (m.retrievalCount > 0) {
      m.clickThroughRate = m.clickThroughCount / m.retrievalCount;
    }
  }

  /** Get copy of memory stats. */
  getMemoryStats(): Record<string, MemoryStatRecord> {
    return { ...this._memories };
  }

  // ── Snapshots & persistence ──

  /** Get a full snapshot of all current stats. */
  snapshot(): StatsSnapshot {
    return {
      tools: { ...this._tools },
      skills: { ...this._skills },
      memories: { ...this._memories },
    };
  }

  /** Persist all stats to the EvolutionStore. */
  async flush(): Promise<void> {
    const now = new Date().toISOString();
    await this._store.writeStats('tool-stats.json', {
      version: 1, updatedAt: now, tools: this._tools,
    });
    await this._store.writeStats('skill-stats.json', {
      version: 1, updatedAt: now, skills: this._skills,
    });
    await this._store.writeStats('memory-stats.json', {
      version: 1, updatedAt: now, memories: this._memories,
    });
    this._log.debug('Stats flushed', {
      tools: Object.keys(this._tools).length,
      skills: Object.keys(this._skills).length,
      memories: Object.keys(this._memories).length,
    });
  }

  /** Load stats from the EvolutionStore. */
  async load(): Promise<void> {
    const toolStore = await this._store.readStats<{ version: number; tools: Record<string, ToolStatRecord> }>('tool-stats.json');
    if (toolStore) this._tools = toolStore.tools;

    const skillStore = await this._store.readStats<{ version: number; skills: Record<string, SkillStatRecord> }>('skill-stats.json');
    if (skillStore) this._skills = skillStore.skills;

    const memStore = await this._store.readStats<{ version: number; memories: Record<string, MemoryStatRecord> }>('memory-stats.json');
    if (memStore) this._memories = memStore.memories;

    this._log.debug('Stats loaded', {
      tools: Object.keys(this._tools).length,
      skills: Object.keys(this._skills).length,
    });
  }
}
