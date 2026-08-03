import { describe, expect, it } from 'vitest';
import { WorkspaceFileTree } from '../WorkspaceFileTree.js';

describe('WorkspaceFileTree read-only contract', () => {
  it('does not expose filesystem mutation methods', () => {
    const prototype = WorkspaceFileTree.prototype as unknown as Record<string, unknown>;
    expect(prototype._createFile).toBeUndefined();
    expect(prototype._createFolder).toBeUndefined();
    expect(prototype._rename).toBeUndefined();
    expect(prototype._renameByPath).toBeUndefined();
    expect(prototype._delete).toBeUndefined();
    expect(prototype._deleteByName).toBeUndefined();
    expect(prototype._moveFile).toBeUndefined();
  });
});
