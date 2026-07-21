import { describe, expect, it } from 'vitest';
import {
  hasExternalContentChange,
  workspaceModelUri,
  workspaceReadOnlyReason,
} from '../WorkspaceIdeUtils.js';

describe('Workspace IDE safety helpers', () => {
  it('creates distinct Monaco model URIs for identical paths in different sessions', () => {
    const first = workspaceModelUri('session-a', 'C:\\work-a', 'primary', 'src/index.ts');
    const second = workspaceModelUri('session-b', 'C:\\work-b', 'primary', 'src/index.ts');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^anoclaw-workspace:\/\/workspace-[a-f0-9]+\/src\/index\.ts$/);
  });

  it('marks truncated workspace reads as read-only previews', () => {
    expect(workspaceReadOnlyReason({ truncated: true, size: 150 * 1024 })).toContain('Read-only preview');
    expect(workspaceReadOnlyReason({ truncated: false, size: 150 * 1024 })).toBeUndefined();
  });

  it('detects an external change that clears a file', () => {
    expect(hasExternalContentChange('', 'previous content')).toBe(true);
    expect(hasExternalContentChange('', '')).toBe(false);
  });
});
