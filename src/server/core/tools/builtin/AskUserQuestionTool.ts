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

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER_CHARS = 12;
const MAX_QUESTION_CHARS = 1000;
const MAX_OPTION_CHARS = 120;

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
      '**Limits:** Max 4 questions per call. Max 4 short option labels per question. Put option trade-offs in the question text when needed. Use multiSelect only when options are non-exclusive.\n\n' +
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
          maxItems: MAX_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_QUESTION_CHARS,
                pattern: '\\S',
                description: 'The question to ask the user',
              },
              header: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_HEADER_CHARS,
                pattern: '\\S',
                description: 'Short label for the question (max 12 characters)',
              },
              options: {
                type: 'array',
                maxItems: MAX_OPTIONS,
                items: { type: 'string', minLength: 1, maxLength: MAX_OPTION_CHARS, pattern: '\\S' },
                description: 'Multiple-choice options. If empty or omitted, free-text input is used.',
              },
              multiSelect: {
                type: 'boolean',
                description: 'Allow multiple options to be selected (default: false)',
              },
            },
            required: ['question', 'header'],
            additionalProperties: false,
          },
          description: 'Array of 1-4 questions to ask the user',
        },
      },
      required: ['questions'],
      additionalProperties: false,
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
    const normalized = normalizeQuestions(params.questions);
    if (normalized.error) {
      return this.makeError(normalized.error, {
        structured: {
          askUserStatus: 'invalid',
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
        },
      });
    }
    const questions = normalized.value ?? [];

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
      `[AWAITING USER RESPONSE]\n\n${formatted}\n\nConversation paused. Waiting for user answers.`,
      {
        structured: {
          askUserStatus: 'awaiting_user',
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          questionCount: questions.length,
          questions,
        },
      },
    );
  }
}

function normalizeQuestions(
  value: unknown,
): { value: Question[]; error?: undefined } | { value?: undefined; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'questions array is required and must not be empty' };
  }
  if (value.length > MAX_QUESTIONS) {
    return { error: `Maximum ${MAX_QUESTIONS} questions allowed per call` };
  }

  const questions: Question[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const prefix = `questions[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `${prefix} must be an object` };
    }
    const record = raw as Record<string, unknown>;

    const questionResult = normalizeString(record.question, `${prefix}.question`, MAX_QUESTION_CHARS);
    if (questionResult.error) return { error: questionResult.error };
    const question = questionResult.value ?? '';

    const headerResult = normalizeString(record.header, `${prefix}.header`, MAX_HEADER_CHARS);
    if (headerResult.error) return { error: headerResult.error };
    const header = headerResult.value ?? '';

    const optionsResult = normalizeOptions(record.options, `${prefix}.options`);
    if (optionsResult.error) return { error: optionsResult.error };
    const options = optionsResult.value ?? [];

    const multiSelectResult = normalizeBoolean(record.multiSelect, `${prefix}.multiSelect`, false);
    if (multiSelectResult.error) return { error: multiSelectResult.error };
    const multiSelect = multiSelectResult.value ?? false;

    if (multiSelect && options.length === 0) {
      return { error: `${prefix}.multiSelect requires non-empty options` };
    }

    questions.push({
      question,
      header,
      ...(options.length ? { options } : {}),
      ...(multiSelect ? { multiSelect: true } : {}),
    });
  }
  return { value: questions };
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or less` };
  }
  return { value: trimmed };
}

function normalizeOptions(
  value: unknown,
  field: string,
): { value: string[]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array of strings` };
  if (value.length > MAX_OPTIONS) return { error: `${field} must contain ${MAX_OPTIONS} items or fewer` };

  const seen = new Set<string>();
  const options: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const optionResult = normalizeString(value[i], `${field}[${i}]`, MAX_OPTION_CHARS);
    if (optionResult.error) return { error: optionResult.error };
    const option = optionResult.value ?? '';
    if (seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return { value: options };
}

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'boolean') return { error: `${field} must be a boolean` };
  return { value };
}
