// ToolResult — factory helpers for creating ToolResult objects
// These are lightweight pure functions; no class needed.

import type { ToolResult } from '../../../shared/types/tool.js';

export interface MakeResultOptions {
  toolCallId?: string;
  tokensUsed?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  structured?: Record<string, unknown>;
  wasTruncated?: boolean;
}

/**
 * Create a successful ToolResult.
 */
export function makeResult(
  content: string,
  opts: MakeResultOptions = {},
): ToolResult {
  const now = Date.now();
  return {
    toolCallId: opts.toolCallId ?? '',
    success: true,
    content,
    structured: opts.structured,
    errorMessage: undefined,
    tokensUsed: opts.tokensUsed ?? Math.ceil(content.length / 4),
    startedAt: opts.startedAt ?? now,
    finishedAt: opts.finishedAt ?? now,
    durationMs: opts.durationMs ?? 0,
    wasTruncated: opts.wasTruncated ?? false,
  };
}

/**
 * Create a failure ToolResult.
 */
export function makeError(
  errorMessage: string,
  opts: MakeResultOptions = {},
): ToolResult {
  const now = Date.now();
  return {
    toolCallId: opts.toolCallId ?? '',
    success: false,
    content: '',
    structured: opts.structured,
    errorMessage,
    tokensUsed: 0,
    startedAt: opts.startedAt ?? now,
    finishedAt: opts.finishedAt ?? now,
    durationMs: opts.durationMs ?? 0,
    wasTruncated: false,
  };
}

/**
 * Create a ToolResult from a raw JSON object (e.g., from transcript).
 */
export function toolResultFromJson(json: Record<string, unknown>): ToolResult {
  return {
    toolCallId: (json.toolCallId as string) ?? '',
    success: (json.success as boolean) ?? false,
    content: (json.content as string) ?? '',
    structured: json.structured as Record<string, unknown> | undefined,
    errorMessage: json.errorMessage as string | undefined,
    tokensUsed: (json.tokensUsed as number) ?? 0,
    startedAt: (json.startedAt as number) ?? 0,
    finishedAt: (json.finishedAt as number) ?? 0,
    durationMs: (json.durationMs as number) ?? 0,
    wasTruncated: (json.wasTruncated as boolean) ?? false,
  };
}
