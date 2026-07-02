/**
 * StallDetector — Agent stall detection and self-recovery (Claude Code circuit breaker pattern)
 *
 * Extracted from AgentLoop.ts. Tracks recent tool call patterns, detects whether the Agent
 * is stuck in an unproductive loop, and triggers escalating strategies (hint → compress context → yield).
 *
 * Detection rules (referencing anochat/agent.js lines 31-75):
 *   1. N consecutive turns with no tool calls → Agent may be stuck in a text-only loop
 *   2. Same tool fails N consecutive times → dead loop
 *   3. ≥3 turns in the last 10 have >50 tool calls each → excessive tooling
 *
 * Escalation strategy:
 *   Level 1 (hint)    — Inject a hint message, guiding the Agent to change approach
 *   Level 2 (compact) — Compress context, forcing reorientation
 *   Level 3 (yield)   — Give up, report stall to upper layer
 */

import {
  STALL_DETECTION_NO_TOOL_TURNS,
  STALL_DETECTION_CONSECUTIVE_FAILURES,
} from '../../../shared/constants.js';

/** Per-turn tool call record */
export interface StallTurn {
  ts: number;
  toolCount: number;
  failed: boolean;
}

/** Stall detection result */
export interface StallResult {
  stalled: boolean;
  action?: 'hint' | 'compact' | 'yield';
  message?: string;
}

/**
 * Stall detector.
 *
 * Records per-turn tool call activity via record(), checks for stall via check().
 * Supports escalating levels: first detection gives a hint, second compresses context,
 * third yields entirely.
 */
export class StallDetector {
  private recentTurns: StallTurn[] = [];
  private consecutiveNoToolCalls = 0;
  private consecutiveToolFailures = 0;
  private consecutiveEmptyResponses = 0; // LLM returned empty content (no text, no tools)
  private lastToolName: string | null = null;
  private escalationLevel = 0; // 0=normal, 1=hint, 2=compact, 3=yield

  /** Record this turn's tool call activity */
  record(toolNames: string[], results: string[]): void {
    const allFailed = results.length > 0
      && results.every((r) => r?.startsWith('Error'));

    this.recentTurns.push({
      ts: Date.now(),
      toolCount: toolNames.length,
      failed: allFailed,
    });
    if (this.recentTurns.length > 10) this.recentTurns.shift();

    // Track no-progress
    if (toolNames.length === 0) {
      this.consecutiveNoToolCalls++;
    } else {
      this.consecutiveNoToolCalls = 0;
      // Track tool failures (same failing tool = dead loop)
      if (allFailed && toolNames[0] === this.lastToolName) {
        this.consecutiveToolFailures++;
      } else if (!allFailed) {
        this.consecutiveToolFailures = 0;
      }
      if (toolNames[0]) this.lastToolName = toolNames[0];
    }
  }

  /** Record LLM returned empty content (no text, no tools) */
  recordEmptyResponse(): void {
    this.consecutiveEmptyResponses++;
    this.consecutiveNoToolCalls++; // empty responses also count as "no tools called"
  }

  /** Check whether currently stalled */
  check(): StallResult {
    // Rule 0: consecutive empty responses → stalled (P0: prevents agent stall loop)
    if (this.consecutiveEmptyResponses >= 3) {
      return this._escalate();
    }
    // Rule 1: consecutive turns with no tool calls → stalled
    if (this.consecutiveNoToolCalls >= STALL_DETECTION_NO_TOOL_TURNS) {
      return this._escalate();
    }
    // Rule 2: same tool fails consecutively → dead loop
    if (this.consecutiveToolFailures >= STALL_DETECTION_CONSECUTIVE_FAILURES) {
      return this._escalate();
    }
    // Rule 3: >50 tool calls in a single turn, 3+ times in the last 10 turns → excessive tooling
    const excessive = this.recentTurns.filter((t) => t.toolCount > 50).length;
    if (excessive >= 3) return this._escalate();

    this.escalationLevel = 0;
    return { stalled: false };
  }

  private _escalate(): StallResult {
    this.escalationLevel++;
    if (this.escalationLevel === 1) {
      return {
        stalled: true,
        action: 'hint',
        message: 'You seem stuck. Try a different approach or use a different tool.',
      };
    }
    if (this.escalationLevel === 2) {
      return {
        stalled: true,
        action: 'compact',
        message: 'Still stuck. Compacting context to reorient...',
      };
    }
    return {
      stalled: true,
      action: 'yield',
      message: 'Agent stalled after multiple recovery attempts.',
    };
  }

  /** Reset all counters (called after compression) */
  reset(): void {
    this.consecutiveNoToolCalls = 0;
    this.consecutiveToolFailures = 0;
    this.consecutiveEmptyResponses = 0;
    this.escalationLevel = 0;
    this.lastToolName = null;
  }
}
