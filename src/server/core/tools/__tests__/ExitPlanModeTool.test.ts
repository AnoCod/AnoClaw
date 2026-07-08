import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ExitPlanModeTool } from '../builtin/ExitPlanModeTool.js';
import { ToolPipeline } from '../ToolPipeline.js';

function ctx(sessionId: string): ExecutionContext {
  return {
    sessionId,
    agentId: 'exit-plan-test-agent',
    workspace: process.cwd(),
    userConfirmed: false,
  };
}

describe('ExitPlanModeTool', () => {
  it('stores normalized exact Bash prompts and exits plan mode', async () => {
    const sessionId = 'exit-plan-valid-session';
    const tool = new ExitPlanModeTool();
    ToolPipeline.enterPlanMode(sessionId);

    const result = await tool.execute({
      allowedPrompts: [
        { tool: 'Bash', prompt: '  npm test  ' },
        { tool: 'Bash', prompt: 'npx tsc --project tsconfig.json --noEmit' },
      ],
    }, ctx(sessionId));

    expect(result.success).toBe(true);
    expect(ToolPipeline.isPlanMode(sessionId)).toBe(false);
    expect(ToolPipeline.getAllowedPrompts(sessionId)).toEqual([
      { tool: 'Bash', prompt: 'npm test' },
      { tool: 'Bash', prompt: 'npx tsc --project tsconfig.json --noEmit' },
    ]);
    expect(result.content).toContain('Auto-approved exact prompts');
    expect(result.structured).toMatchObject({
      allowedPromptCount: 2,
      allowedTools: ['Bash'],
    });
  });

  it('clears stale approved prompts when none are provided', async () => {
    const sessionId = 'exit-plan-clear-session';
    const tool = new ExitPlanModeTool();
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: 'npm test' }]);

    const result = await tool.execute({}, ctx(sessionId));

    expect(result.success).toBe(true);
    expect(ToolPipeline.getAllowedPrompts(sessionId)).toEqual([]);
    expect(result.structured).toMatchObject({ allowedPromptCount: 0 });
  });

  it('rejects invalid approved prompt entries before leaving plan mode', async () => {
    const sessionId = 'exit-plan-invalid-tool-session';
    const tool = new ExitPlanModeTool();
    ToolPipeline.enterPlanMode(sessionId);
    ToolPipeline.setAllowedPrompts(sessionId, [{ tool: 'Bash', prompt: 'npm test' }]);

    const result = await tool.execute({
      allowedPrompts: [{ tool: 'Write', prompt: 'overwrite file' }],
    }, ctx(sessionId));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('allowedPrompts[0].tool');
    expect(ToolPipeline.isPlanMode(sessionId)).toBe(true);
    expect(ToolPipeline.getAllowedPrompts(sessionId)).toEqual([]);
  });

  it.each([
    ['non-array value', 'npm test', 'allowedPrompts must be an array'],
    ['non-object entry', ['npm test'], 'allowedPrompts[0] must be an object'],
    ['empty prompt', [{ tool: 'Bash', prompt: '   ' }], 'allowedPrompts[0].prompt must not be empty'],
    ['oversized prompt', [{ tool: 'Bash', prompt: 'x'.repeat(4001) }], 'allowedPrompts[0].prompt must be 4000 characters or less'],
  ])('rejects %s', async (_name, allowedPrompts, expectedMessage) => {
    const sessionId = `exit-plan-invalid-${String(_name).replace(/\W+/g, '-')}`;
    const result = await new ExitPlanModeTool().execute({ allowedPrompts }, ctx(sessionId));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain(expectedMessage);
    expect(ToolPipeline.getAllowedPrompts(sessionId)).toEqual([]);
  });
});
