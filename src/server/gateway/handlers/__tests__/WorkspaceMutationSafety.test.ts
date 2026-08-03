import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleCreateWorkspaceDir,
  handleCreateWorkspaceFile,
  handleDeleteWorkspaceFile,
  handleMoveWorkspaceFile,
  handleRenameWorkspaceFile,
  handleWriteWorkspaceFile,
} from '../WorkspaceHandlers.js';

describe('Workspace mutation endpoints are permanently read-only', () => {
  it('rejects every legacy mutation without parsing a body', async () => {
    const readBody = vi.fn(async () => { throw new Error('must not parse mutation bodies'); });
    const calls: Array<Promise<void>> = [];
    const captures: Array<{ status?: number; body?: Record<string, unknown> }> = [];
    const capture = () => {
      const result: { status?: number; body?: Record<string, unknown> } = {};
      captures.push(result);
      return ((_: ServerResponse, status: number, body: unknown) => {
        result.status = status;
        result.body = body as Record<string, unknown>;
      });
    };
    const req = { url: '/api/v1/workspace/file?path=important.txt' } as IncomingMessage;
    const res = {} as ServerResponse;

    calls.push(handleCreateWorkspaceDir(req, res, capture(), readBody));
    calls.push(handleCreateWorkspaceFile(req, res, capture(), readBody));
    calls.push(handleDeleteWorkspaceFile(req, res, capture(), '127.0.0.1', 15730));
    calls.push(handleRenameWorkspaceFile(req, res, capture(), readBody));
    calls.push(handleMoveWorkspaceFile(req, res, capture(), readBody));
    calls.push(handleWriteWorkspaceFile(req, res, capture(), readBody));
    await Promise.all(calls);

    expect(readBody).not.toHaveBeenCalled();
    expect(captures).toHaveLength(6);
    for (const result of captures) {
      expect(result.status).toBe(405);
      expect(result.body).toMatchObject({
        error: 'Method Not Allowed',
        code: 'WORKSPACE_READ_ONLY',
      });
    }
  });
});
