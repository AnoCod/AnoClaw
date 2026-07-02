/**
 * AnoClaw -- Tool System Types
 * Core type definitions for the tool execution system: risk levels,
 * interrupt behavior, and the ToolResult contract.
 */

/** Risk classification for tool operations. */
export enum RiskLevel {
  Safe     = 'Safe',
  Low      = 'Low',
  Medium   = 'Medium',
  High     = 'High',
  Critical = 'Critical',
}

/** Behavior when an interrupt is requested during tool execution. */
export enum InterruptBehavior {
  Cancel = 'cancel',
  Block  = 'block',
}

import type { ExecutionContext } from './session.js';

/** Standard result shape returned by every tool execution. */
export interface ToolResult {
  toolCallId: string;
  success: boolean;
  content: string;
  structured?: unknown;
  errorMessage?: string;
  tokensUsed: number;
  startedAt: number;      // Date.now()
  finishedAt: number;     // Date.now()
  durationMs: number;
  wasTruncated: boolean;
}
