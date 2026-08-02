import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertDisposablePackagedRuntimeRoot,
  assertPathInside,
  containsAnoClawUninstallEntry,
  detectSecretLiteral,
  expectedReleaseArtifactNames,
  findSensitiveValuePaths,
} from '../qualification-lib.mjs';

describe('release qualification helpers', () => {
  it('derives deterministic v2.0.1 artifact names', () => {
    expect(expectedReleaseArtifactNames('2.0.1')).toEqual({
      installer: 'AnoClaw.Setup.2.0.1.exe',
      portable: 'AnoClaw-2.0.1-win-unpacked.zip',
    });
  });

  it('finds secret-bearing response keys without flagging token limits', () => {
    expect(findSensitiveValuePaths({
      llm: { apiKey: 'hidden', maxTokens: 4096 },
      nested: [{ access_token: 'hidden-too' }],
      apiKeyConfigured: true,
    })).toEqual(['$.llm.apiKey', '$.nested[0].access_token']);
  });

  it('reports credential pattern names without returning credential values', () => {
    const fake = `prefix sk-${'a'.repeat(40)} suffix`;
    const matches = detectSecretLiteral(fake);
    expect(matches).toEqual(['OpenAI-compatible API key']);
    expect(JSON.stringify(matches)).not.toContain(fake);
  });

  it('recognizes AnoClaw uninstall records without matching unrelated products', () => {
    const installed = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\example',
      '    DisplayName    REG_SZ    AnoClaw 2.0.0',
    ].join('\r\n');
    const unrelated = '    DisplayName    REG_SZ    AnoClaw Helper Toolkit';

    expect(containsAnoClawUninstallEntry(installed)).toBe(true);
    expect(containsAnoClawUninstallEntry(unrelated)).toBe(false);
  });

  it('rejects cleanup targets outside the generated release tree', () => {
    const repo = path.resolve('F:/workspace/AnoClaw');
    expect(assertDisposablePackagedRuntimeRoot(
      path.join(repo, 'release9', 'win-unpacked', 'resources', 'app.asar.unpacked'),
      repo,
    )).toContain('app.asar.unpacked');
    expect(() => assertDisposablePackagedRuntimeRoot(path.join(repo, 'data'), repo))
      .toThrow(/Refusing to clean non-release runtime root/);
    expect(() => assertPathInside(repo, repo)).toThrow(/must be a child/);
  });
});
