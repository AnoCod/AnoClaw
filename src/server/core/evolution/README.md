# Evolution System

Self-evolution system that learns from usage patterns to improve agent performance. 6 coordinated modules: pattern detection → auto-skill generation, keyword extraction, usage statistics, session tagging, quality scoring, and evolution analysis/reports.

## Public API

### EvolutionManager (Singleton)

```ts
import { EvolutionManager } from './EvolutionManager.js';
const em = EvolutionManager.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `init()` | — | `Promise<void>` | Initialize all 6 modules, load persisted data |
| `saveScore(score)` | `score: QualityScore` | `Promise<QualityScore>` | Save a quality score (M5). Emits `score:saved`. |
| `recordToolCall(toolName, success, tokensUsed, durationMs)` | `toolName: string`, `success: boolean`, `tokensUsed: number`, `durationMs: number` | `void` | Record a tool execution (M3) |
| `analyze(options?)` | `options?: Partial<AnalyzeOptions>` | `Promise<EvolutionReport>` | Run full evolution analysis (M6). Emits `analysis:complete`. |
| `generateSkillFromPattern(patternId)` | `patternId: string` | `Promise<string \| null>` | Generate SKILL.md from a detected pattern (M1) |
| `flush()` | — | `Promise<void>` | Persist all volatile data to disk |

**Module accessors** (all public on the instance):

| Property | Type | Module |
|----------|------|--------|
| `em.store` | `EvolutionStore` | Data persistence |
| `em.scores` | `QualityScoreManager` | M5 |
| `em.stats` | `StatsCollector` | M3 |
| `em.tagger` | `SessionTagger` | M4 |
| `em.patterns` | `PatternDetector` | M1 |
| `em.keywords` | `KeywordExtractor` | M2 |
| `em.engine` | `EvolutionEngine` | M6 |

### M1: PatternDetector

```ts
class PatternDetector {
  recordToolSequence(sessionId, toolSequence, totalTokenCost): Promise<EvolutionPattern | null>;
  getSkillCandidates(threshold?): EvolutionPattern[];     // threshold default: 3
  getExistingSkillsNeedingReeval(threshold?): EvolutionPattern[];  // default: 5
  linkSkill(patternId, skillId): void;
  getPattern(patternId): EvolutionPattern | undefined;
  getAllPatterns(): EvolutionPattern[];
  flush(): Promise<void>;
  load(): Promise<void>;
}
```

Detects repeated tool call sequences across sessions. Normalizes signatures (sorted parameter names) so the same pattern from different sessions matches. Triggers auto-skill generation at count ≥ 3. Re-evaluates at count ≥ 5.

### M2: KeywordExtractor

```ts
class KeywordExtractor {
  extract(userMessages, assistantMessages, startTurn, endTurn): {
    userKeywords: string[];
    llmKeywords: string[];
    summary: string;
    turnRange: [number, number];
  };
}
```

Periodic keyword extraction from conversation turns. Results persisted to session metadata as `evolutionKeywords`. Feeds into M4 session tagging.

### M3: StatsCollector

```ts
class StatsCollector {
  recordToolCall(toolName, success, tokensUsed, durationMs): void;
  recordSkillLoad(skillName): void;
  recordSkillReference(skillName): void;
  recordMemoryRetrieval(memoryName): void;
  recordMemoryClick(memoryName): void;
  getToolStats(): Record<string, ToolStatRecord>;
  getSkillStats(): Record<string, SkillStatRecord>;
  getMemoryStats(): Record<string, MemoryStatRecord>;
  snapshot(): StatsSnapshot;
  flush(): Promise<void>;
  load(): Promise<void>;
}
```

Collects usage statistics: tool call counts/success rates/duration, skill loads/references, memory retrievals/click-through rates. Auto-flushes every 5 minutes.

### M4: SessionTagger

```ts
class SessionTagger {
  addTag(sessionId, label, category, confidence?): void;
  removeTag(sessionId, label): boolean;
  getTags(sessionId): SessionTag[];
  getSessionsByTag(label): string[];
  hasTag(sessionId, label): boolean;
  getAllLabels(): string[];
  toJSON(sessionId): SessionTag[];
  fromJSON(sessionId, tags): void;
}

interface SessionTag {
  label: string;
  category: 'auto' | 'user';
  confidence: number;  // 0.0 - 1.0
  createdAt: string;   // ISO8601
}
```

Auto-tags sessions on `loop:completed` and from keyword extraction. User tags override auto tags. Tags persisted to session metadata → displayed as frontend tag chips.

### M5: QualityScoreManager

```ts
class QualityScoreManager {
  saveScore(score: QualityScore): Promise<QualityScore>;
  getRecentScores(limit?): Promise<QualityScore[]>;
  getSessionScores(sessionId): Promise<QualityScore[]>;
  getAgentAverage(agentId): Promise<number>;
  getSessionAverage(sessionId): Promise<number>;
  getStats(): Promise<ScoreStats>;
  reload(): Promise<void>;
}

interface QualityScore {
  id: string;
  sessionId: string;
  messageId: string;
  agentId: string;
  score: number;       // 1-5
  comment?: string;
  createdAt: string;
}
```

Human quality scores (1-5). Same (messageId + sessionId + agentId) overwrites previous. Stored as daily-sharded JSONL in `data/evolution/scores/`.

### M6: EvolutionEngine

```ts
class EvolutionEngine {
  analyze(options: AnalyzeOptions): Promise<EvolutionReport>;
  applyReport(report: EvolutionReport, sourceMode: 'dry-run' | 'apply'): Promise<boolean>;
}

interface EvolutionReport {
  id: string;
  createdAt: string;
  trigger: 'manual' | 'auto' | 'scheduled';
  mode: 'dry-run' | 'apply';
  skillChanges: SkillChange[];           // archive, promote_branch, keep
  memoryFindings: MemoryFinding[];       // stale, merge, keep, modify
  promptSuggestions: PromptSuggestion[]; // tweak, keep
  tokenFindings: TokenFinding[];         // high token usage recommendations
  summary: { totalFindings, criticalFindings, estimatedSavingsTokens };
}

interface AnalyzeOptions {
  mode: 'dry-run' | 'apply';
  skillArchiveDays?: number;     // default: 30
  scoreThreshold?: number;       // default: 2.5
  promptMinScores?: number;      // default: 20
}
```

Runs full analysis across all 5 data modules. Produces actionable findings: skills to archive (stale >30 days), low-quality agents (avg score < threshold), high-token tools. All changes require human review before application.

### EvolutionStore

```ts
class EvolutionStore {
  init(): Promise<void>;
  writeStats(fileName, data): Promise<void>;    // Atomic write (temp + rename)
  readStats<T>(fileName): Promise<T | null>;
  writePatterns(data): Promise<void>;
  readPatterns(): Promise<PatternStore | null>;
  appendScore(score): Promise<void>;             // Daily JSONL shard
  readScores(date?): Promise<QualityScore[]>;    // Optional date filter
  computeScoreIndex(): Promise<ScoreIndex>;
  readScoreIndex(): Promise<ScoreIndex | null>;
}
```

File layout:
```
data/evolution/
  stats/
    skill-stats.json
    memory-stats.json
    tool-stats.json
    patterns.json
  scores/
    YYYY-MM-DD.jsonl      (daily sharded quality scores)
    index.json             (aggregated summary)
```

## Event Wiring (EvolutionExtension)

The `EvolutionExtension` wires all modules via `TypedEventBus`:

| Event | → Module | Action |
|-------|----------|--------|
| `tool:execution_completed` | M3 + M1 | Record tool stats + buffer tool sequence |
| `loop:completed` | M4 + M1 | Auto-tag session + flush tool buffer → pattern detection |
| `loop:keyword_turn` | M2 + M4 | Extract keywords → persist + derive domain tags |

**Skill generation threshold**: Pattern count ≥ 3 across sessions → `generateSkillFromPattern()` creates `skills/auto-{tools}-{ts}/SKILL.md`.

## Dependencies

### Called by
- `EvolutionExtension` — starts wiring at boot
- `EvolutionRoute` — HTTP API for reports, scores, stats
- `AgentRuntime` hooks — tool execution recording
- `Settings page` (frontend) — triggers `analyze()` + quality scores

### Depends on
- `EvolutionStore` — persistence for all modules
- `SkillManager` — auto-generated skills registered here
- `TypedEventBus` — event subscriptions in EvolutionExtension
- `SessionManager` — session metadata for tags + keywords

## Constraints

- All analysis is **read-only** in dry-run mode — no files changed
- Apply mode archives stale skills to `skills/.archived/`
- Quality scores use append-only JSONL (daily shards) — never modify existing records
- Pattern detection normalizes tool signatures (sorts param names) for cross-session matching
- Auto-flush interval: 5 minutes
- Skill generation threshold: 3 occurrences across sessions
- `data/evolution/` directory auto-created on first use
- All file writes are atomic (temp + rename)
