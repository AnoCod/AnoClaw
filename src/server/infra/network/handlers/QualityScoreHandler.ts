// QualityScoreHandler — handles 'quality_score' WS messages from frontend
// Receives user ratings (1-5 stars + optional comment) and persists via EvolutionManager.

import type { WsMessageHandler } from '../WsMessageRouter.js';
import { EvolutionManager } from '../../../core/evolution/EvolutionManager.js';
import type { QualityScore } from '../../../../shared/types/evolution.js';

export const qualityScoreHandler: WsMessageHandler = async (ctx) => {
  const payload = ctx.data as Record<string, unknown>;

  const scoreValue = payload.score as number;
  if (typeof scoreValue !== 'number' || scoreValue < 1 || scoreValue > 5) {
    ctx.ws.send(ctx.sessionId, {
      type: 'quality_score_error',
      error: 'Score must be a number between 1 and 5',
    });
    return;
  }

  try {
    const mgr = EvolutionManager.getInstance();
    const score: QualityScore = {
      id: `score-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: payload.sessionId as string || ctx.sessionId,
      agentId: payload.agentId as string || 'unknown',
      messageId: payload.messageId as string || `msg-${Date.now()}`,
      turnNumber: (payload.turnNumber as number) || 0,
      score: scoreValue,
      comment: payload.comment as string || undefined,
      createdAt: new Date().toISOString(),
      source: 'human',
    };

    const saved = await mgr.saveScore(score);

    ctx.ws.send(ctx.sessionId, {
      type: 'quality_score_ack',
      id: saved.id,
      status: 'saved',
    });
  } catch (err) {
    ctx.ws.send(ctx.sessionId, {
      type: 'quality_score_error',
      error: `Failed to save score: ${(err as Error).message}`,
    });
  }
};
