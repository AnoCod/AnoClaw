/**
 * ToolProfiler — in-memory tool call timing collector.
 *
 * Records every tool execution (tool name, session, success, duration)
 * and exposes per-session breakdowns for debugging and optimization.
 *
 * Ring-buffered per session — keeps last 500 calls to avoid unbounded growth.
 */
import type { ToolResult } from '../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';

interface ToolTrace {
  toolName: string;
  sessionId: string;
  agentId: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
}

interface PerToolStat {
  toolName: string;
  calls: number;
  successCount: number;
  failCount: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  recentTraces: Array<{ durationMs: number; success: boolean; ago: string }>;
}

interface SessionStats {
  sessionId: string;
  totalCalls: number;
  totalMs: number;
  avgMs: number;
  lastActiveAt: string;
  tools: Record<string, PerToolStat>;
}

const MAX_TRACES_PER_SESSION = 500;
const MAX_RECENT_TRACES_PER_TOOL = 10;

export class ToolProfiler {
  private static _instance: ToolProfiler;
  private _traces: Map<string, ToolTrace[]> = new Map(); // keyed by sessionId

  static getInstance(): ToolProfiler {
    if (!ToolProfiler._instance) ToolProfiler._instance = new ToolProfiler();
    return ToolProfiler._instance;
  }

  static resetInstance(): void { ToolProfiler._instance = null!; }

  record(
    toolName: string,
    ctx: ExecutionContext,
    result: ToolResult,
  ): void {
    const trace: ToolTrace = {
      toolName,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      success: result.success,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    };

    let arr = this._traces.get(ctx.sessionId);
    if (!arr) {
      arr = [];
      this._traces.set(ctx.sessionId, arr);
    }
    arr.push(trace);
    // Ring-buffer cap
    if (arr.length > MAX_TRACES_PER_SESSION) {
      arr.splice(0, arr.length - MAX_TRACES_PER_SESSION);
    }
  }

  /** Get per-tool breakdown for a session. */
  stats(sessionId: string): SessionStats | null {
    const traces = this._traces.get(sessionId);
    if (!traces || traces.length === 0) return null;

    const toolMap = new Map<string, PerToolStat>();
    let totalMs = 0;

    for (const t of traces) {
      totalMs += t.durationMs;
      let stat = toolMap.get(t.toolName);
      if (!stat) {
        stat = {
          toolName: t.toolName,
          calls: 0, successCount: 0, failCount: 0,
          totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0,
          recentTraces: [],
        };
        toolMap.set(t.toolName, stat);
      }
      stat.calls++;
      if (t.success) stat.successCount++; else stat.failCount++;
      stat.totalMs += t.durationMs;
      if (t.durationMs < stat.minMs) stat.minMs = t.durationMs;
      if (t.durationMs > stat.maxMs) stat.maxMs = t.durationMs;
    }

    const tools: Record<string, PerToolStat> = {};
    for (const [name, raw] of toolMap) {
      const ago = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
      tools[name] = {
        ...raw,
        avgMs: Math.round(raw.totalMs / raw.calls),
        minMs: raw.minMs === Infinity ? 0 : raw.minMs,
        recentTraces: traces
          .filter(t => t.toolName === name)
          .slice(-MAX_RECENT_TRACES_PER_TOOL)
          .map(t => ({
            durationMs: t.durationMs,
            success: t.success,
            ago: ago(Date.now() - t.timestamp),
          })),
      };
    }

    return {
      sessionId,
      totalCalls: traces.length,
      totalMs,
      avgMs: Math.round(totalMs / traces.length),
      lastActiveAt: new Date(traces[traces.length - 1].timestamp).toISOString(),
      tools,
    };
  }

  /** List all session IDs that have profiled data. */
  sessionIds(): string[] {
    return Array.from(this._traces.keys());
  }

  /** Global aggregate — slowest / most-called tools across all sessions. */
  globalAggregate(): {
    tools: Array<{ toolName: string; calls: number; avgMs: number; maxMs: number }>;
    totalSessions: number;
    totalCalls: number;
  } {
    const agg = new Map<string, { calls: number; totalMs: number; maxMs: number }>();
    let totalCalls = 0;

    for (const traces of this._traces.values()) {
      for (const t of traces) {
        totalCalls++;
        let a = agg.get(t.toolName);
        if (!a) { a = { calls: 0, totalMs: 0, maxMs: 0 }; agg.set(t.toolName, a); }
        a.calls++;
        a.totalMs += t.durationMs;
        if (t.durationMs > a.maxMs) a.maxMs = t.durationMs;
      }
    }

    const tools = Array.from(agg.entries())
      .map(([name, a]) => ({
        toolName: name,
        calls: a.calls,
        avgMs: Math.round(a.totalMs / a.calls),
        maxMs: a.maxMs,
      }))
      .sort((a, b) => b.calls - a.calls);

    return { tools, totalSessions: this._traces.size, totalCalls };
  }
}
