import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

describe('AnoClaw 3 startup boundary', () => {
  it('does not load the retired v2 Agent, Session, or coordination stores', async () => {
    const source = await fsp.readFile(
      path.resolve('src', 'server', 'main.ts'),
      'utf-8',
    );

    expect(source).not.toContain("ensureWritableDir('data', 'agents')");
    expect(source).not.toContain("ensureWritableDir('data', 'sessions')");
    expect(source).not.toContain("ensureWritableDir('data', 'coordination')");
    expect(source).not.toContain("core/coordination/CoordinationService");
    expect(source).not.toContain("core/coordination/CoordinationScheduler");
    expect(source).not.toContain('loadAgentConfig(');
    expect(source).not.toContain('buildDefaultAgentConfigs(');
    expect(source).toContain("ensureWritableDir('data', 'v3')");
  });
});
