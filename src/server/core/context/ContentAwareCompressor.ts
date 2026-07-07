/**
 * ContentAwareCompressor — L2.5 content-aware tool output compression.
 *
 * Sits between L2 (truncation) and L3 (message pruning) in the compression
 * pipeline. Detects the content type of each tool result and applies a
 * type-specific compression strategy — not blind head+tail truncation.
 *
 * Zero external dependencies. Pure regex + string processing. Runs
 * synchronously in the main event loop (<5ms for typical outputs).
 */

// ══════════════════════════════════════════════════════════════
// Content type enum
// ══════════════════════════════════════════════════════════════

/** @internal — Used internally by compressToolOutput. Exported for barrel re-export convenience. */
export enum ContentType {
  BuildOutput = 'build',
  SearchResults = 'search',
  GitDiff = 'diff',
  JsonOutput = 'json',
  PlainText = 'text',
}

// ══════════════════════════════════════════════════════════════
// Detection regexes (compiled once)
// ══════════════════════════════════════════════════════════════

const DIFF_HEADER_RE = /^(?:diff\s+--git|index\s+[0-9a-f]+|(?:---|\+\+\+)\s+\S+|@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@)/m;
const SEARCH_RESULT_RE = /^[^\s]+\/\S+:\d+:/m;
const LOG_LEVEL_RE = /\b(?:ERROR|FATAL|CRITICAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;
const JSON_START_RE = /^\s*[\[{]/;
const TIMESTAMP_RE = /\b(?:\d{4}[-/]\d{2}[-/]\d{2}|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

/** Minimum lines before we bother with content-aware compression. */
const MIN_LINES = 3;

/** Maximum chars for the compressed output (falls back to truncation beyond this). */
const MAX_COMPRESSED_CHARS = 6000;

// ══════════════════════════════════════════════════════════════
// Detection
// ══════════════════════════════════════════════════════════════

/**
 * Detect the content type of a tool result string.
 * Uses fast regex heuristics — no parsing, no allocations beyond line scanning.
 */
/** @internal */
export function detectContentType(content: string): ContentType {
  const lines = content.split('\n');
  const lineCount = lines.length;

  // JSON — check early; compact JSON is often 1-2 lines with huge content
  if (JSON_START_RE.test(content) && content.length > 100) {
    return ContentType.JsonOutput;
  }

  if (lineCount < MIN_LINES) return ContentType.PlainText;

  // Sample both head and tail lines — log levels often appear later in output
  const headSample = lines.slice(0, Math.min(10, lineCount));
  const tailSample = lines.slice(Math.max(0, lineCount - 10));
  const sample = [...headSample, ...tailSample];
  let diffHits = 0;
  let searchHits = 0;
  let logHits = 0;

  for (const line of sample) {
    if (DIFF_HEADER_RE.test(line)) diffHits++;
    if (SEARCH_RESULT_RE.test(line)) searchHits++;
    if (LOG_LEVEL_RE.test(line) || TIMESTAMP_RE.test(line)) logHits++;
  }

  // Diff: needs at least a diff header + some context
  if (diffHits >= 2) return ContentType.GitDiff;

  // Search: grep -n format, needs multiple hits
  if (searchHits >= Math.min(4, lineCount)) return ContentType.SearchResults;

  // Build output: log levels or timestamps in a majority of lines
  if (logHits >= Math.min(5, Math.floor(lineCount * 0.3))) return ContentType.BuildOutput;

  return ContentType.PlainText;
}

// ══════════════════════════════════════════════════════════════
// Build output compression
// ══════════════════════════════════════════════════════════════

const TEMPLATE_RE = /^(.+?)(?:\d[\d.]*|0x[0-9a-f]+|["'][^"']*["'])(.+)$/;
const ERROR_RE = /\b(?:ERROR|FATAL|CRITICAL|FAIL|FAILED)\b/i;
const WARN_RE = /\bWARN(?:ING)?\b/i;

/**
 * Compress build/log output.
 *
 * Strategy:
 * 1. Always preserve ERROR/FATAL/CRITICAL lines verbatim
 * 2. Always preserve WARNING lines (with count cap at 10)
 * 3. Repeated template lines → collapse to "[T × N] template"
 * 4. Unique lines → keep, up to 20
 */
function compressBuildOutput(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 10) return content;

  const out: string[] = [];
  const templates = new Map<string, { count: number; sample: string }>();
  const deferred: string[] = [];
  let warnCount = 0;

  for (const line of lines) {
    // Errors always kept verbatim
    if (ERROR_RE.test(line)) {
      out.push(line);
      continue;
    }

    // Warnings — keep up to 10, mark the rest
    if (WARN_RE.test(line)) {
      warnCount++;
      if (warnCount <= 10) {
        out.push(line);
      } else if (warnCount === 11) {
        out.push(`[+ additional WARNING lines omitted — ${warnCount - 10} so far]`);
      }
      continue;
    }

    // Try template matching for repeated patterns
    const templateKey = templateKeyFor(line);
    if (templateKey) {
      const existing = templates.get(templateKey);
      if (existing) {
        existing.count++;
      } else {
        templates.set(templateKey, { count: 1, sample: line });
        deferred.push(templateKey);
      }
    } else {
      // Unique line — keep it
      out.push(line);
    }
  }

  // Emit template summaries
  if (templates.size > 0) {
    out.push('\n── Template summary ──');
    for (const key of deferred) {
      const t = templates.get(key)!;
      if (t.count > 2) {
        out.push(`[T × ${t.count}] ${t.sample}`);
      } else {
        // Just 1-2 occurrences — emit as-is
        for (let i = 0; i < t.count; i++) out.push(t.sample);
      }
    }
  }

  return out.join('\n').slice(0, MAX_COMPRESSED_CHARS);
}

/** Extract a template key by replacing numeric/alphanumeric tokens with placeholders. */
function templateKeyFor(line: string): string | null {
  // Skip lines that are too short to be templatable
  if (line.length < 15) return null;
  // Skip lines that already have error/warn markers (handled separately)
  if (ERROR_RE.test(line) || WARN_RE.test(line)) return null;

  const replaced = line
    .replace(/\b\d+(?:\.\d+)?\b/g, '«N»')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '«HEX»')
    .replace(/"[^"]{4,}"|'[^']{4,}'/g, '«STR»')
    .replace(/\b[a-f0-9]{8,}\b/gi, '«HASH»');

  // Only return a key if something was actually replaced (it's a template)
  if (replaced === line) return null;
  return replaced;
}

// ══════════════════════════════════════════════════════════════
// Search results compression
// ══════════════════════════════════════════════════════════════

const SEARCH_LINE_RE = /^(.+?):(\d+):(.+)$/;

/**
 * Compress search/grep output.
 *
 * Strategy:
 * 1. Parse file:line:content format
 * 2. Group by file
 * 3. Per file: keep first 3 matches, summarize the rest
 * 4. If >20 files, keep first 20 + summary
 */
function compressSearchResults(content: string): string {
  const lines = content.split('\n');
  const files = new Map<string, { lines: Array<{ num: string; text: string }> }>();

  let matchCount = 0;
  for (const line of lines) {
    const m = line.match(SEARCH_LINE_RE);
    if (m) {
      const file = m[1];
      const entry = files.get(file) || { lines: [] };
      entry.lines.push({ num: m[2], text: m[3] });
      files.set(file, entry);
      matchCount++;
    }
  }

  // If we couldn't parse search format, fall back
  if (matchCount === 0) return content;

  const out: string[] = [];
  let shownFiles = 0;

  for (const [file, data] of files) {
    shownFiles++;
    const totalInFile = data.lines.length;

    if (shownFiles <= 20) {
      const keep = data.lines.slice(0, 3);
      for (const l of keep) {
        out.push(`${file}:${l.num}:${l.text}`);
      }
      if (totalInFile > 3) {
        out.push(`  ── +${totalInFile - 3} more matches in ${file}`);
      }
    } else {
      // Count remaining files and summarize
      let remainingFiles = 0;
      let remainingMatches = 0;
      const entries = [...files.entries()];
      for (let i = 20; i < entries.length; i++) {
        remainingFiles++;
        remainingMatches += entries[i][1].lines.length;
      }
      out.push(`[+${remainingFiles} more files with ${remainingMatches} total matches]`);
      break;
    }
  }

  return out.join('\n').slice(0, MAX_COMPRESSED_CHARS);
}

// ══════════════════════════════════════════════════════════════
// Git diff compression
// ══════════════════════════════════════════════════════════════

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;
const CHANGE_RE = /^[+-]/;
const DIFF_META_RE = /^(?:diff\s+--git|index\s+[0-9a-f]+|(?:---|\+\+\+)\s+\S+|new\s+file|deleted\s+file|rename\s|similarity\s|Binary\s+files)/;

/**
 * Compress unified diff output.
 *
 * Strategy:
 * 1. Keep all diff metadata lines (diff --git, index, ---/+++, etc.)
 * 2. Keep all hunk headers (@@ ... @@)
 * 3. Keep all + and - lines (actual changes)
 * 4. Context lines: keep only 2 before and 2 after change blocks
 * 5. Drop large blocks of unchanged context
 */
function compressGitDiff(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let contextBuffer: string[] = [];
  let inChangeBlock = false;
  let contextAfterChange = 0;
  const MAX_CONTEXT_BEFORE = 2;
  const MAX_CONTEXT_AFTER = 2;

  function flushContext(keep: number): void {
    if (contextBuffer.length <= keep) {
      out.push(...contextBuffer);
    } else {
      // Keep last N context lines before a change
      const keepFrom = Math.max(0, contextBuffer.length - keep);
      const dropped = keepFrom;
      if (dropped > 3) {
        out.push(`... [${dropped} context lines dropped]`);
      } else if (dropped > 0) {
        out.push(...contextBuffer.slice(0, dropped));
      }
      out.push(...contextBuffer.slice(keepFrom));
    }
    contextBuffer = [];
  }

  for (const line of lines) {
    // Diff metadata — always keep
    if (DIFF_META_RE.test(line)) {
      flushContext(0);
      out.push(line);
      continue;
    }

    // Hunk header — always keep
    if (HUNK_HEADER_RE.test(line)) {
      flushContext(0);
      out.push(line);
      inChangeBlock = false;
      contextAfterChange = 0;
      continue;
    }

    // Change line — keep, and mark that we're in a change block
    if (CHANGE_RE.test(line) && !line.startsWith('---') && !line.startsWith('+++')) {
      if (!inChangeBlock) {
        flushContext(MAX_CONTEXT_BEFORE);
      }
      inChangeBlock = true;
      contextAfterChange = 0;
      out.push(line);
      continue;
    }

    // Context line (neither metadata, hunk header, nor change)
    if (inChangeBlock) {
      if (contextAfterChange < MAX_CONTEXT_AFTER) {
        out.push(line);
        contextAfterChange++;
      } else if (contextAfterChange === MAX_CONTEXT_AFTER) {
        contextAfterChange++;
        out.push('... [context lines dropped]');
      }
      // else already dropped — continue skipping
    } else {
      // Before any change block — buffer context
      contextBuffer.push(line);
    }
  }

  return out.join('\n').slice(0, MAX_COMPRESSED_CHARS);
}

// ══════════════════════════════════════════════════════════════
// JSON output compression
// ══════════════════════════════════════════════════════════════

/**
 * Compress JSON output.
 *
 * Strategy:
 * - If it's a JSON array of uniform objects (same keys): keep first 3, last 3, stats
 * - If it's a JSON array of primitives: keep first 5, last 5, count
 * - If it's a small JSON (<15 items / <2000 chars): pass through
 * - Otherwise: truncate to sample
 */
function compressJsonOutput(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length < 500) return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return content; // not valid JSON, leave it alone
  }

  if (Array.isArray(parsed)) {
    return compressJsonArray(parsed);
  }

  if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length > 30) {
      return JSON.stringify({
        _keys_count: keys.length,
        _keys_sample: keys.slice(0, 20),
        ...Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).slice(0, 10),
        ),
      });
    }
  }

  return content;
}

function compressJsonArray(arr: unknown[]): string {
  if (arr.length <= 10) return JSON.stringify(arr);

  const first = arr[0];

  // Array of uniform objects
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = Object.keys(first as Record<string, unknown>);
    // Check uniformity: do all items have the same keys?
    const allUniform = arr.every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const itemKeys = Object.keys(item as Record<string, unknown>);
      return itemKeys.length === keys.length && keys.every(k => k in (item as Record<string, unknown>));
    });

    if (allUniform) {
      const sample = [
        ...arr.slice(0, 3),
        { _rows_omitted: arr.length - 6, _keys: keys },
        ...arr.slice(-3),
      ];
      return JSON.stringify(sample);
    }
    // Non-uniform objects — just sample
    const sample = [...arr.slice(0, 5), { _rows_omitted: arr.length - 10 }, ...arr.slice(-5)];
    return JSON.stringify(sample);
  }

  // Array of primitives
  if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') {
    if (arr.length <= 20) return JSON.stringify(arr);
    const sample = [
      ...arr.slice(0, 5),
      `... ${arr.length - 10} items omitted`,
      ...arr.slice(-5),
    ];
    return JSON.stringify(sample);
  }

  // Mixed array — sample
  if (arr.length <= 15) return JSON.stringify(arr);
  return JSON.stringify([...arr.slice(0, 5), `... ${arr.length - 10} items`, ...arr.slice(-5)]);
}

/**
 * Check if a value is a compression sentinel (placeholder inserted during
 * array/object compression to indicate omitted rows/items).
 * Sentinel objects have a `_rows_omitted` key; sentinel strings match the
 * "... N items omitted" pattern.
 */
export function isCompressionSentinel(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    return '_rows_omitted' in (value as Record<string, unknown>);
  }
  if (typeof value === 'string') {
    return /\d+ items? omitted/.test(value);
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════

export interface CompressionNote {
  type: ContentType;
  originalChars: number;
  compressedChars: number;
  savingsPct: number;
}

/**
 * Compress a tool result string using content-aware strategies.
 * Returns the compressed string and a metadata note.
 * Never throws — falls back to original content on any error.
 */
export function compressToolOutput(content: string): { output: string; note: CompressionNote } {
  if (!content || content.length < 200) {
    return {
      output: content,
      note: { type: ContentType.PlainText, originalChars: content.length, compressedChars: content.length, savingsPct: 0 },
    };
  }

  let result: string;
  let type: ContentType;

  try {
    type = detectContentType(content);

    switch (type) {
      case ContentType.BuildOutput:
        result = compressBuildOutput(content);
        break;
      case ContentType.SearchResults:
        result = compressSearchResults(content);
        break;
      case ContentType.GitDiff:
        result = compressGitDiff(content);
        break;
      case ContentType.JsonOutput:
        result = compressJsonOutput(content);
        break;
      default:
        result = content;
        break;
    }
  } catch {
    // Any unexpected error → pass through original
    return {
      output: content,
      note: { type: ContentType.PlainText, originalChars: content.length, compressedChars: content.length, savingsPct: 0 },
    };
  }

  // Safety: never return more than the original
  if (result.length > content.length) {
    result = result.slice(0, content.length);
  }

  const savingsPct = content.length > 0
    ? Math.round((1 - result.length / content.length) * 100)
    : 0;

  return {
    output: result,
    note: {
      type,
      originalChars: content.length,
      compressedChars: result.length,
      savingsPct,
    },
  };
}
