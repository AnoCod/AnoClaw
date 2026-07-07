// EvolutionRoute — analysis, apply, and stats endpoints for the evolution system
// The EvolutionExtension must be started for this to work.

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { EvolutionManager } from '../../core/evolution/EvolutionManager.js';
import { sendJson, readBody } from '../RouteHelpers.js';

export class EvolutionStatsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/evolution/stats';
  description = 'Get live evolution system stats (tools, patterns, scores, tags)';
  category = 'Evolution';

  async handle(
    _match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    const mgr = EvolutionManager.getInstance();
    if (!mgr.isInitialized) await mgr.init();

    const toolStats = mgr.stats.getToolStats();
    const skillStats = mgr.stats.getSkillStats();
    const memoryStats = mgr.stats.getMemoryStats();
    const scoreSummary = await mgr.scores.getStats();
    const patterns = mgr.patterns.getAllPatterns();
    const tagLabels = mgr.tagger.getAllLabels();
    const tagCount = mgr.tagger.totalTags;

    // Top 5 tools by call count
    const topTools = Object.entries(toolStats)
      .map(([name, s]) => ({
        name,
        callCount: s.callCount,
        successRate: s.callCount > 0 ? s.successCount / s.callCount : 0,
        avgDurationMs: s.avgDurationMs,
        avgTokens: s.avgTokens,
        lastUsedAt: s.lastUsedAt,
      }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    // Patterns summary
    const skillCandidates = patterns.filter(p => p.skillId === null && p.count >= 3).length;
    const patternsWithSkills = patterns.filter(p => p.skillId !== null).length;

    sendJson(res, 200, {
      tools: topTools,
      toolCount: Object.keys(toolStats).length,
      patterns: {
        total: patterns.length,
        skillCandidates,
        withSkills: patternsWithSkills,
      },
      scores: {
        totalScores: scoreSummary.totalScores,
        globalAvg: scoreSummary.globalAvg,
        byAgent: scoreSummary.byAgent,
        bySession: scoreSummary.bySession,
      },
      skills: {
        tracked: Object.keys(skillStats).length,
      },
      memories: {
        tracked: Object.keys(memoryStats).length,
      },
      tags: {
        totalPairs: tagCount,
        uniqueLabels: tagLabels.length,
        labels: tagLabels.slice(0, 20),
      },
    });
    return true;
  }
}

export class EvolutionAnalyzeRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/evolution/analyze';
  description = 'Trigger evolution system analysis and return report';
  category = 'Evolution';

  async handle(
    _match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    const mgr = EvolutionManager.getInstance();
    if (!mgr.isInitialized) await mgr.init();
    const report = await mgr.analyze({ mode: 'dry-run' });
    sendJson(res, 200, report);
    return true;
  }
}

export class EvolutionApplyRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/evolution/apply';
  description = 'Apply an evolution report (archive skills, etc.)';
  category = 'Evolution';

  async handle(
    _match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): Promise<boolean> {
    const mgr = EvolutionManager.getInstance();
    if (!mgr.isInitialized) await mgr.init();

    try {
      const report = await readBody(req) as any;
      const success = await mgr.engine.applyReport(report, 'apply');
      sendJson(res, 200, { success, message: 'Evolution report applied successfully' });
    } catch (err) {
      sendJson(res, 500, { success: false, error: (err as Error).message });
    }
    return true;
  }
}
