// Evolution System — shared types
// Data structures for self-evolution: quality scores, usage stats, patterns

// ── Quality Score (Module 5) ───────────────────────────────────────

export interface QualityScore {
  id: string;
  sessionId: string;
  agentId: string;
  messageId: string;
  turnNumber: number;
  score: number;          // 1-5
  comment?: string;
  createdAt: string;      // ISO8601
  updatedAt?: string;
  source: 'human' | 'llm_judge';
}

// ── Score Index (aggregated) ───────────────────────────────────────

export interface ScoreIndex {
  version: number;
  updatedAt: string;
  summary: {
    totalScores: number;
    avgScore: number;
    byAgent: Record<string, { count: number; avg: number }>;
    bySession: Record<string, { count: number; avg: number }>;
  };
}

// ── Skill Stats (Module 3) ─────────────────────────────────────────

export interface SkillStats {
  loadCount: number;              // loaded into prompt path
  matchL0Count: number;           // matched L0 index, not loaded full
  execReferencedCount: number;    // agent actually referenced content
  patchCount: number;             // content-modified count
  avgScore: number;               // from QualityScore for sessions using this skill
  lastUsedAt: string;
  lastPatchedAt: string;
}

export interface SkillStatsStore {
  version: number;
  updatedAt: string;
  skills: Record<string, SkillStats>;
}

// ── Memory Stats (Module 3) ────────────────────────────────────────

export interface MemoryStats {
  retrievalCount: number;
  clickThroughCount: number;
  clickThroughRate: number;
  lastRetrievedAt: string;
}

export interface MemoryStatsStore {
  version: number;
  updatedAt: string;
  memories: Record<string, MemoryStats>;
}

// ── Tool Stats (Module 3) ──────────────────────────────────────────

export interface ToolStats {
  callCount: number;
  successCount: number;
  totalTokens: number;
  totalDurationMs: number;
  avgTokens: number;
  p50Tokens: number;
  p95Tokens: number;
  lastUsedAt: string;
}

export interface ToolStatsStore {
  version: number;
  updatedAt: string;
  tools: Record<string, ToolStats>;
}

// ── Evolution Pattern (Module 1) ───────────────────────────────────

export interface ToolCallSignature {
  tool: string;
  params: string[];  // parameter names, not values
}

export interface EvolutionPattern {
  patternId: string;
  signature: ToolCallSignature[];
  count: number;
  firstSeen: string;
  lastSeen: string;
  sessions: string[];
  avgTokenCost: number;
  skillId: string | null;
}

export interface PatternStore {
  version: number;
  updatedAt: string;
  patterns: EvolutionPattern[];
}

// ── Evolution Store File Paths ─────────────────────────────────────

export const EVOLUTION_DIR = 'data/evolution';
export const SCORES_DIR = 'data/evolution/scores';
export const STATS_DIR = 'data/evolution/stats';

export const SCORE_INDEX_FILE = 'index.json';
export const SKILL_STATS_FILE = 'skill-stats.json';
export const MEMORY_STATS_FILE = 'memory-stats.json';
export const TOOL_STATS_FILE = 'tool-stats.json';
export const PATTERNS_FILE = 'patterns.json';
