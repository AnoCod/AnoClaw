// AskUserQuestionTool - asks the user one or more questions
// Used when the agent is blocked or needs clarification.
// Questions support single-select (options) or free-text input.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

interface Question {
  question: string;
  header: string;
  options?: string[];
  multiSelect?: boolean;
}

export class AskUserQuestionTool extends Tool {
  static category = 'Planning & Communication';
  static toolDescription = 'Asks the user clarifying questions when blocked on a decision.';

  name(): string {
    return 'AskUserQuestion';
  }

  description(): string {
    return 'Ask the user one or more questions to gather information or clarify requirements. Use when genuinely blocked. Supports up to 4 questions per call. The conversation pauses until the user responds.';
  }

  prompt(): string {
    return '## AskUserQuestion Usage\n' +
      'Ask the user when you are genuinely stuck on a decision only they can make. Do NOT use for trivial confirmations or things you can infer.\n\n' +
      '**When to use:** Multiple valid approaches with different trade-offs. Missing critical requirement. User preference genuinely matters for the outcome.\n\n' +
      '**When NOT to use:** You can figure it out from context. It\'s a minor style choice. You\'re just being polite. There\'s only one reasonable approach.\n\n' +
      '**Limits:** Max 4 questions per call. Max 4 options per question. Each option needs a label and description. Use multiSelect for non-exclusive choices.\n\n' +
      'Only ask questions that change what you do. Don\'t ask "should I proceed?" - just do it.';
  }

  minRole(): string { return 'MainAgent'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                minLength: 1,
                pattern: '\\S',
                description: 'The question to ask the user',
              },
              header: {
                type: 'string',
                minLength: 1,
                maxLength: 12,
                pattern: '\\S',
                description: 'Short label for the question (max 12 characters)',
              },
              options: {
                type: 'array',
                maxItems: 4,
                items: { type: 'string', minLength: 1, pattern: '\\S' },
                description: 'Multiple-choice options. If empty or omitted, free-text input is used.',
              },
              multiSelect: {
                type: 'boolean',
                description: 'Allow multiple options to be selected (default: false)',
              },
            },
            required: ['question', 'header'],
          },
          description: 'Array of 1-4 questions to ask the user',
        },
      },
      required: ['questions'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return true;
  }

  shouldDefer(): boolean {
    return true; // Does not consume a model turn
  }

  // No tool call card shown - results rendered as structured Q&A
  userFacingName(_input?: Record<string, unknown>): string { return ''; }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  requiresUserInteraction(): boolean {
    return true; // This tool inherently needs user input
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const questions = params.questions as Question[] | undefined;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return this.makeError('questions array is required and must not be empty');
    }

    if (questions.length > 4) {
      return this.makeError('Maximum 4 questions allowed per call');
    }

    // Validate each question
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question || typeof q.question !== 'string') {
        return this.makeError(`Question ${i + 1}: "question" field is required`);
      }
      if (!q.header || typeof q.header !== 'string') {
        return this.makeError(`Question ${i + 1}: "header" field is required`);
      }
      if (q.header.length > 12) {
        return this.makeError(
          `Question ${i + 1}: "header" must be 12 characters or fewer`
        );
      }
    }

    // Format questions for display
    const formatted = questions
      .map((q, i) => {
        let text = `Q${i + 1}: ${q.question}`;
        if (q.options && q.options.length > 0) {
          text +=
            '\nOptions: ' +
            q.options.map((o, j) => `${j + 1}. ${o}`).join(' | ');
          if (q.multiSelect) {
            text += '\n(Multiple selections allowed)';
          }
        } else {
          text += '\n(Free-text response)';
        }
        return text;
      })
      .join('\n\n');

    return this.makeResult(
      `[AWAITING USER RESPONSE]\n\n${formatted}\n\nConversation paused. Waiting for user answers.`
    );
  }
}
