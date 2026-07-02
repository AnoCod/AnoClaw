import { describe, it, expect, beforeEach } from 'vitest';
import { StallDetector } from '../StallDetector.js';

function recordTurns(detector: StallDetector, turns: Array<{ tools: string[]; results: string[] }>) {
  for (const turn of turns) {
    detector.record(turn.tools, turn.results);
  }
}

describe('StallDetector', () => {
  let detector: StallDetector;

  beforeEach(() => {
    detector = new StallDetector();
  });

  // ── Rule 1: consecutive no-tool turns ──

  it('is not stalled when tools are called each turn', () => {
    for (let i = 0; i < 4; i++) {
      detector.record(['read'], ['content']);
      expect(detector.check().stalled).toBe(false);
    }
  });

  it('detects stall after 5 consecutive no-tool turns', () => {
    recordTurns(detector, Array(4).fill({ tools: [], results: [] }));
    expect(detector.check().stalled).toBe(false);

    detector.record([], []);
    expect(detector.check().stalled).toBe(true);
  });

  it('resets no-tool counter when a tool is called', () => {
    recordTurns(detector, Array(4).fill({ tools: [], results: [] }));
    detector.record(['read'], ['content']);
    expect(detector.check().stalled).toBe(false);
  });

  // ── Rule 2: same tool fails consecutively ──

  it('detects stall after 3 consecutive failures of the same tool', () => {
    // Turn 1 sets lastToolName but doesn't count (no prior tool to match)
    detector.record(['BadTool'], ['Error: fail 0']);
    expect(detector.check().stalled).toBe(false);
    // Turns 2-4: 3 consecutive failures → stall
    detector.record(['BadTool'], ['Error: fail 1']);
    expect(detector.check().stalled).toBe(false);
    detector.record(['BadTool'], ['Error: fail 2']);
    expect(detector.check().stalled).toBe(false);
    detector.record(['BadTool'], ['Error: fail 3']);
    expect(detector.check().stalled).toBe(true);
  });

  it('does not count failures of different tools as consecutive', () => {
    detector.record(['ToolA'], ['Error: fail']);
    detector.record(['ToolB'], ['Error: fail']);
    detector.record(['ToolA'], ['Error: fail']);
    expect(detector.check().stalled).toBe(false);
  });

  it('resets failure counter on success', () => {
    detector.record(['BadTool'], ['Error: fail 1']);
    detector.record(['BadTool'], ['Error: fail 2']);
    detector.record(['BadTool'], ['ok']);
    detector.record(['BadTool'], ['Error: fail 1']);
    detector.record(['BadTool'], ['Error: fail 2']);
    expect(detector.check().stalled).toBe(false);
  });

  // ── Rule 3: excessive tooling (>50 tools per turn, 3+ times in last 10) ──

  it('detects stall from excessive tool usage', () => {
    for (let i = 0; i < 3; i++) {
      detector.record(
        Array(51).fill('tool'),
        Array(51).fill('ok'),
      );
    }
    expect(detector.check().stalled).toBe(true);
  });

  it('does not flag excessive tooling with only 2 high-volume turns', () => {
    for (let i = 0; i < 2; i++) {
      detector.record(
        Array(51).fill('tool'),
        Array(51).fill('ok'),
      );
    }
    expect(detector.check().stalled).toBe(false);
  });

  // ── Escalation ──

  it('escalates hint → compact → yield on repeated checks without reset', () => {
    // Trigger stall condition — 5 consecutive no-tool turns
    recordTurns(detector, Array(5).fill({ tools: [], results: [] }));

    // Each check() on a still-stalled state escalates
    const r1 = detector.check();
    expect(r1.stalled).toBe(true);
    expect(r1.action).toBe('hint');

    const r2 = detector.check();
    expect(r2.stalled).toBe(true);
    expect(r2.action).toBe('compact');

    const r3 = detector.check();
    expect(r3.stalled).toBe(true);
    expect(r3.action).toBe('yield');

    // Capped at yield
    const r4 = detector.check();
    expect(r4.stalled).toBe(true);
    expect(r4.action).toBe('yield');
  });

  it('caps at yield on further checks', () => {
    recordTurns(detector, Array(5).fill({ tools: [], results: [] }));

    // Escalate up to yield
    detector.check(); // hint
    detector.check(); // compact
    detector.check(); // yield

    // Further checks stay at yield
    const r = detector.check();
    expect(r.stalled).toBe(true);
    expect(r.action).toBe('yield');
  });

  // ── Reset ──

  it('reset clears all counters', () => {
    recordTurns(detector, Array(5).fill({ tools: [], results: [] }));
    expect(detector.check().stalled).toBe(true);

    detector.reset();
    expect(detector.check().stalled).toBe(false);
  });
});
