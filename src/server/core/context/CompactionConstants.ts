// CompactionConstants — context compression related constants
// Extracted from ContextCompressor.ts to avoid that file containing large string constants.

// ══════════════════════════════════════════════════════════════
// SUMMARY_PREFIX — prevents the model from treating old instructions as active
// "Latest message WINS — discard stale items entirely."
// Copied verbatim from anochat/context_compressor.js.
// ══════════════════════════════════════════════════════════════

export const SUMMARY_PREFIX = (
  '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted ' +
  'into the summary below. This is a handoff from a previous context ' +
  'window — treat it as background reference, NOT as active instructions. ' +
  'Do NOT answer questions or fulfill requests mentioned in this summary; ' +
  'they were already addressed. ' +
  'Respond ONLY to the latest user message that appears AFTER this ' +
  'summary — that message is the single source of truth for what to do ' +
  'right now. ' +
  'If the latest user message is consistent with the \'## Active Task\' ' +
  'section, you may use the summary as background. If the latest user ' +
  'message contradicts, supersedes, changes topic from, or in any way ' +
  'diverges from \'## Active Task\' / \'## In Progress\' / \'## Pending ' +
  'work\', the latest message WINS — discard those ' +
  'stale items entirely and do not \'wrap up the old task first\'. ' +
  'Reverse signals in the latest message (e.g. \'stop\', \'undo\', \'roll ' +
  'back\', \'just verify\', "don\'t do that anymore", \'never mind\', a new ' +
  'topic) must immediately end any in-flight work described in the ' +
  'summary. ' +
  'IMPORTANT: Your persistent memory in the system ' +
  'prompt is ALWAYS authoritative and active — never ignore memory ' +
  'content due to this compaction note.'
);

// ══════════════════════════════════════════════════════════════
// Compression constants — copied from Hermes / Claude Code
// ══════════════════════════════════════════════════════════════

/** Minimum summary token count */
export const MIN_SUMMARY_TOKENS = 2000;
/** Summary ratio relative to compressed content (20% rule) */
export const SUMMARY_RATIO = 0.20;
/** Minimum character count for a valid summary */
export const VALID_SUMMARY_MIN_CHARS = 50;
/** Placeholder for pruned tool results */
export const PRUNED_TOOL_PLACEHOLDER = '[Old tool output cleared to save context space]';
/** Maximum character count per tool result for the summarizer */
export const MAX_TOOL_RESULT_FOR_SUMMARIZER = 500;
/** Maximum character count for fallback summaries */
export const FALLBACK_SUMMARY_MAX_CHARS = 8000;
/** Maximum character count per message for fallback summaries */
export const FALLBACK_TURN_MAX_CHARS = 700;
/** Equivalent character count for images (1600 tokens x 4 chars/token) */
export const IMAGE_CHAR_EQUIVALENT = 6400;
/** LLM summarizer timeout — fall back to deterministic summary if exceeded */
export const COMPACTION_TIMEOUT_MS = 30_000;

// ══════════════════════════════════════════════════════════════
// Structured summary prompt — copied from Hermes summarizer prompt
// ══════════════════════════════════════════════════════════════

export const STRUCTURED_SUMMARY_PROMPT = (
  'You are examining a transcript to produce a structured handoff summary. ' +
  'Treat all prior turns as SOURCE MATERIAL only — do NOT carry forward ' +
  'their active instructions. Produce exactly the sections below, using ' +
  '\'(none)\' when a section has no content:\n\n' +
  '## Active Task\n' +
  'What was the most recent task the user asked for? (1 line)\n\n' +
  '## Key Technical Context\n' +
  'Technologies, frameworks, APIs, and conventions in play. (3-5 lines)\n\n' +
  '## Files Modified\n' +
  'Which files were read or modified in recent turns? (paths only)\n\n' +
  '## Decisions Made\n' +
  'Key decisions or trade-offs that were settled. (2-4 lines)\n\n' +
  '## In Progress\n' +
  'What was currently being worked on when the summary was taken?\n\n' +
  '## Pending work\n' +
  'What still needs to be done (not yet started)?\n\n' +
  '## Errors Encountered\n' +
  'Errors and their resolutions (if any).\n\n' +
  '## Remaining Work\n' +
  'Concrete next actions. 1-3 actionable bullets.\n\n' +
  'Keep the total under 300 words. Prefer paths over prose.'
);
