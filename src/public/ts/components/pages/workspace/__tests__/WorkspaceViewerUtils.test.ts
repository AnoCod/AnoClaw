import { describe, expect, it } from 'vitest';
import {
  workspaceModelUri,
  workspaceReadOnlyReason,
} from '../WorkspaceViewerUtils.js';

describe('Workspace read-only viewer helpers', () => {
  it('creates distinct Monaco model URIs for identical paths in different sessions', () => {
    const first = workspaceModelUri('session-a', 'C:\\work-a', 'primary', 'src/index.ts');
    const second = workspaceModelUri('session-b', 'C:\\work-b', 'primary', 'src/index.ts');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^anoclaw-workspace:\/\/workspace-[a-f0-9]+\/src\/index\.ts$/);
  });

  it('marks truncated workspace reads as read-only previews', () => {
    expect(workspaceReadOnlyReason({ truncated: true, size: 2 * 1024 * 1024, previewBytes: 1024 * 1024 }))
      .toContain('first 1.0 MB');
    expect(workspaceReadOnlyReason({ truncated: false, size: 150 * 1024 })).toBeUndefined();
  });
});
