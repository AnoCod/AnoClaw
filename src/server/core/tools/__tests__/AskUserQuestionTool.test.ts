import { describe, expect, it } from 'vitest';
import { AskUserQuestionTool } from '../builtin/AskUserQuestionTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'ask-session',
  agentId: 'main-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('AskUserQuestionTool', () => {
  it('rejects malformed question entries before pausing for user input', async () => {
    const nullEntry = await new AskUserQuestionTool().execute({
      questions: [null],
    }, ctx);
    expect(nullEntry.success).toBe(false);
    expect(nullEntry.errorMessage).toContain('questions[0] must be an object');
    expect(nullEntry.structured).toMatchObject({
      askUserStatus: 'invalid',
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });

    const badOptions = await new AskUserQuestionTool().execute({
      questions: [
        {
          question: 'Which route?',
          header: 'Route',
          options: ['Fast', '   '],
        },
      ],
    }, ctx);
    expect(badOptions.success).toBe(false);
    expect(badOptions.errorMessage).toContain('questions[0].options[1] must not be empty');

    const badMultiSelect = await new AskUserQuestionTool().execute({
      questions: [
        {
          question: 'Which routes?',
          header: 'Routes',
          multiSelect: true,
        },
      ],
    }, ctx);
    expect(badMultiSelect.success).toBe(false);
    expect(badMultiSelect.errorMessage).toContain('multiSelect requires non-empty options');
  });

  it('normalizes questions and returns awaiting-user metadata', async () => {
    const result = await new AskUserQuestionTool().execute({
      questions: [
        {
          question: '  Which route should I take?  ',
          header: ' Route ',
          options: [' Fast ', 'Fast', ' Safe '],
        },
        {
          question: '  Which checks matter?  ',
          header: 'Checks',
          options: [' Tests ', ' Build '],
          multiSelect: true,
        },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('[AWAITING USER RESPONSE]');
    expect(result.content).toContain('1. Fast | 2. Safe');
    expect(result.content).toContain('(Multiple selections allowed)');
    expect(result.structured).toMatchObject({
      askUserStatus: 'awaiting_user',
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      questionCount: 2,
      questions: [
        {
          question: 'Which route should I take?',
          header: 'Route',
          options: ['Fast', 'Safe'],
        },
        {
          question: 'Which checks matter?',
          header: 'Checks',
          options: ['Tests', 'Build'],
          multiSelect: true,
        },
      ],
    });
  });
});
