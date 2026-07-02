# Context Compression System

Manages LLM context window pressure through a 5-layer compression pipeline. Compaction only affects the in-memory message array — the persisted JSONL always retains full history. Integrates with AgentLoop to trigger compaction when token usage exceeds thresholds.

## Public API

### ContextCompressor (Singleton)

```ts
import { ContextCompressor } from './ContextCompressor.js';
const cc = ContextCompressor.getInstance();
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `compact(messages, contextWindow?, threshold?)` | `messages: readonly Message[]`, `contextWindow?: number`, `threshold?: number` | `Promise<CompactionResult>` | Run the full 5-layer compression pipeline |
| `setSummarizer(fn)` | `fn: SummarizerFn` | `void` | Set external LLM-based summarizer |
| `compressToolOutputsWithStrategy(messages)` | `messages: Message[]` | `Message[]` | L2.5: Content-aware tool output compression |
| `truncateToolOutputs(messages)` | `messages: Message[]` | `Message[]` | L2: Blind tool output truncation |
| `pruneMessages(messages, contextWindow)` | `messages: Message[]`, `contextWindow: number` | `Message[]` | L3: Message pruning (keep head + budget-based tail) |
| `generateSummary(messages, contextWindow, threshold?)` | `messages: Message[]`, `contextWindow: number`, `threshold?: number` | `Promise<{ messages, summary, wasCompacted }>` | L4: LLM summary compression |
| `buildFallbackSummary(messages, keepRecent)` | `messages: Message[]`, `keepRecent: number` | `string` | Deterministic fallback summary (no API call) |
| `prepareSummarizerInput(messages, keepRecent)` | `messages: Message[]`, `keepRecent: number` | `{ transcript: string; files: string[] }` | Format messages for the summarizer |

### ContentAwareCompressor

```ts
import { compressToolOutput, detectContentType, ContentType } from './ContentAwareCompressor.js';

function compressToolOutput(content: string): { output: string; note: CompressionNote };
function detectContentType(content: string): ContentType;

enum ContentType {
  BuildOutput = 'build',
  SearchResults = 'search',
  GitDiff = 'diff',
  JsonOutput = 'json',
  PlainText = 'text',
}

interface CompressionNote {
  type: ContentType;
  originalChars: number;
  compressedChars: number;
  savingsPct: number;
}
```

### CompactionManager

```ts
import { compactAndRebuildMessages, shouldCompact } from './CompactionManager.js';

async function compactAndRebuildMessages(
  messages: ApiMsgLite[],
  contextWindow: number,
  sessionId: string,
  tailCount?: number,       // default: 15
): Promise<CompactionResult>;

function shouldCompact(
  compactCheckCounter: number,
  estimatedTokens: number,
  lastCompactionTokenCount: number,
  contextWindow: number,
  checkInterval?: number,   // default: 8
): boolean;
```

### TokenCounter

```ts
class TokenCounter {
  static estimate(text: string): number;
  static estimateMessages(messages: readonly Message[]): number;
  static breakdown(systemPrompt, tools, skillsText, messages, contextWindow?): TokenBreakdown;
  static isOverThreshold(usedTokens, contextWindow, threshold?): boolean;
  static canProceed(usedTokens, contextWindow): boolean;
  static usagePercent(usedTokens, contextWindow): number;
  static realTokenizerAvailable(): boolean;
}
```

## 5-Layer Compression Pipeline

```
L1: Token Buffer Check
  └→ needsCompression() evaluates ratio against context window

L2.5: Content-Aware Compression (NEW — runs BEFORE L2)
  └→ Detects content type → applies type-specific compression
      BuildOutput → collapse repeated templates, keep errors
      SearchResults → group by file, cap 3 matches/file, 20 files
      GitDiff → keep changes, drop context gaps
      JsonOutput → sample arrays, truncate large objects

L2: Tool Output Truncation
  └→ Truncate oversized tool results >200 chars to placeholders

L3: Message Pruning
  └→ Keep system message (head) + budget-based tail
  └→ Prune tool results >1024 chars in middle section
  └→ Fix orphaned tool_call/tool_result pairs

L4: LLM Summary Compression
  └→ Generate structured summary of middle section
  └→ Budget: 20% of compressed content, min 2000, max ~32000 tokens
  └→ Timeout: 30s → falls back to deterministic summary

L5: Semantic Dedup
  └→ Deduplicate repeated tool results
```

## Compression Thresholds

| Usage | Status | Action |
|-------|--------|--------|
| < 70% | Normal | No compaction |
| 70-85% | Warning | L1-L3 (truncation + pruning) |
| > 85% | Critical | L4 (LLM summary) forced |

## Summary Format

All summaries include the `SUMMARY_PREFIX` guard:

> "[CONTEXT COMPACTION — REFERENCE ONLY] ... The latest message WINS — discard stale items entirely."

This prevents the "zombie task" bug where the LLM continues working on a task from the compacted history.

The structured summary template includes:
- **Active Task** — current task (1 line)
- **Key Technical Context** — technologies, frameworks
- **Files Modified** — paths only
- **Decisions Made** — key trade-offs
- **In Progress** — what was being worked on
- **Pending work** — not yet started
- **Errors Encountered** — and resolutions
- **Remaining Work** — 1-3 actionable bullets

## Content-Aware Compression Strategies

| Type | Detection | Strategy | Savings |
|------|-----------|----------|---------|
| BuildOutput | Log levels / timestamps in majority of lines | Keep errors verbatim, collapse repeated templates, cap warnings at 10 | ~60-90% |
| SearchResults | `file:line:content` pattern | Group by file, keep 3 matches/file, 20 files max | ~50-80% |
| GitDiff | `diff --git` / `@@` hunk headers | Keep metadata + changes, drop context gaps, 2-line context window | ~40-70% |
| JsonOutput | Starts with `[` or `{` | Sample arrays (first 3 + last 3), truncate objects >30 keys | ~30-80% |
| PlainText | Default | Pass through unchanged | — |

## TokenCounter

Uses `gpt-tokenizer` for accurate counting when available (compatible with DeepSeek/GPT-4 tokenizers). Falls back to CJK-aware heuristic estimation (chars/4, CJK chars ×1.5). Chunks large inputs at 100K chars to avoid BPE stack overflow.

## Dependencies

### Called by
- `AgentLoopLLM` — calls `compactAndRebuildMessages()` when threshold exceeded
- `AgentLoopCompaction` — shared compaction + message-rebuild logic
- `AgentLoop` — calls `shouldCompact()` to check trigger conditions

### Depends on
- `TokenCounter` — token estimation
- `ContentAwareCompressor` — L2.5 intelligent compression
- `CompressionStrategy` — compression level determination
- `CompactionConstants` — thresholds, summary templates
- `TypedEventBus` — emits `loop:compaction_triggered` for monitoring
- External summarizer (LLM) — injected via `setSummarizer()`

## Constraints

- **Compaction only affects in-memory array** — JSONL on disk always keeps full history
- Never calls `rewriteHistory()` — that would permanently delete messages
- Summarizer timeout: 30 seconds → falls back to deterministic summary
- Fallback summary max: 8000 chars
- Summary min valid length: 50 chars (below this, summary is discarded)
- Tail budget: max(15% of est. tokens, 5% of context window)
- Orphaned tool_call/tool_result pairs at tail boundary are always kept together
- Content-aware compression runs synchronously (<5ms typical) — no external calls
- Content-aware compressor never returns more than original length
