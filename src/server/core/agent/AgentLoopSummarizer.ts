import type { Message } from '../../../shared/types/session.js';
import { SUMMARY_MAX_TOKENS } from '../../../shared/constants.js';
import type { SummarizerFn } from '../context/ContextCompressor.js';
import { ContextCompressor } from '../context/ContextCompressor.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';

export interface AgentLoopSummarizerConfig {
  provider: string;
  modelName: string;
  contextWindow: number;
  apiUrl?: string;
  apiKey?: string;
}

export interface FocusedSummarizerTranscript {
  transcript: string;
  selectedMessageIds: string[];
  anchorMessageIds: string[];
  tokenBudget: number;
}

const SUMMARIZER_CONTEXT_RATIO = 0.62;
const SUMMARIZER_BUDGET_MULTIPLIER = 6;
const ANCHOR_BUDGET_RATIO = 0.34;
const RECENT_BUDGET_RATIO = 0.66;
const SINGLE_MESSAGE_BUDGET_RATIO = 0.45;

const PATH_RE = /(?:[~/]|[A-Z]:\\)[^\s`'")\]}<>]+/;
const DECISION_RE = /\b(goal|objective|plan|todo|next|pending|decision|decided|constraint|must|never|always|remember|checkpoint|milestone|done|completed|fixed|failed|error|blocked|remaining|follow[- ]?up)\b/i;
const CJK_DECISION_RE = /(目标|计划|待办|下一步|决策|决定|约束|必须|不要|永远|记住|里程碑|完成|修复|失败|错误|阻塞|剩余|继续|暂停)/;

function rolePrefix(role: Message['role']): string {
  switch (role) {
    case 'user':
      return 'USER';
    case 'assistant':
      return 'ASSISTANT';
    case 'tool':
      return 'TOOL';
    default:
      return 'SYSTEM';
  }
}

function messageTokens(msg: Message): number {
  return TokenCounter.estimate(renderMessageForSummary(msg));
}

function clipToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || TokenCounter.estimate(text) <= budget) return text;

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (TokenCounter.estimate(candidate) <= budget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best ? `${best.trimEnd()}\n[truncated for summarizer budget]` : '';
}

function renderMessageForSummary(msg: Message): string {
  const lines = [`[${rolePrefix(msg.role)}${msg.compressed ? ' compacted' : ''}${msg.id ? ` id=${msg.id}` : ''}]`];
  if (msg.content) lines.push(msg.content);

  if (msg.toolCalls?.length) {
    const calls = msg.toolCalls.map((call) => {
      const params = JSON.stringify(call.params ?? {});
      return `${call.toolName}(${params})`;
    });
    lines.push(`Tool calls: ${calls.join('; ')}`);
  }

  if (msg.toolResults?.length) {
    for (const result of msg.toolResults) {
      const status = result.success ? 'ok' : 'error';
      const content = result.errorMessage || result.content || '';
      lines.push(`Tool result ${result.toolCallId} [${status}]: ${content}`);
    }
  }

  return lines.join('\n').trim();
}

function hasPathReference(msg: Message): boolean {
  return PATH_RE.test(msg.content || '') || (msg.toolResults ?? []).some((result) => PATH_RE.test(result.content || ''));
}

function isAnchorMessage(msg: Message, index: number, messages: readonly Message[]): boolean {
  if (msg.compressed || msg.id?.startsWith('compact-summary-')) return true;
  if (msg.role === 'user' && messages.slice(0, index).every((prior) => prior.role !== 'user')) return true;
  if (msg.role === 'user' && (DECISION_RE.test(msg.content || '') || CJK_DECISION_RE.test(msg.content || ''))) return true;
  if (msg.role === 'assistant' && (DECISION_RE.test(msg.content || '') || CJK_DECISION_RE.test(msg.content || ''))) return true;
  if (msg.toolCalls?.length || msg.toolResults?.some((result) => !result.success || result.errorMessage)) return true;
  return hasPathReference(msg);
}

function transcriptTokenBudget(contextWindow: number, summaryBudget: number): number {
  const contextBound = Math.floor(contextWindow * SUMMARIZER_CONTEXT_RATIO);
  const summaryBound = Math.ceil(summaryBudget * SUMMARIZER_BUDGET_MULTIPLIER);
  return Math.max(1, Math.min(contextBound, summaryBound));
}

function addMessageWithinBudget(
  selected: Message[],
  selectedIds: Set<string>,
  msg: Message,
  budget: number,
  usedTokens: { value: number },
): boolean {
  if (selectedIds.has(msg.id)) return true;

  const rendered = renderMessageForSummary(msg);
  const tokens = TokenCounter.estimate(rendered);
  if (usedTokens.value + tokens <= budget) {
    selected.push(msg);
    selectedIds.add(msg.id);
    usedTokens.value += tokens;
    return true;
  }

  const remaining = budget - usedTokens.value;
  const singleMessageBudget = Math.floor(budget * SINGLE_MESSAGE_BUDGET_RATIO);
  const clippedBudget = Math.min(remaining, singleMessageBudget);
  if (clippedBudget <= 0) return false;

  const clipped = clipToTokenBudget(rendered, clippedBudget);
  if (!clipped) return false;

  selected.push({ ...msg, content: clipped, toolCalls: [], toolResults: [] });
  selectedIds.add(msg.id);
  usedTokens.value += TokenCounter.estimate(clipped);
  return false;
}

/**
 * Build summarizer input from goal/task anchors plus a recent tail, using the
 * active model context window instead of fixed message or character limits.
 */
export function buildFocusedSummarizerTranscript(
  messages: readonly Message[],
  contextWindow: number,
  summaryBudget: number,
): FocusedSummarizerTranscript {
  const tokenBudget = transcriptTokenBudget(contextWindow, summaryBudget);
  const anchorBudget = Math.max(1, Math.floor(tokenBudget * ANCHOR_BUDGET_RATIO));
  const recentBudget = Math.max(1, tokenBudget - anchorBudget);

  const anchors: Message[] = [];
  const anchorIds = new Set<string>();
  const anchorTokens = { value: 0 };
  messages.forEach((msg, index) => {
    if (!isAnchorMessage(msg, index, messages)) return;
    addMessageWithinBudget(anchors, anchorIds, msg, anchorBudget, anchorTokens);
  });

  const recent: Message[] = [];
  const recentIds = new Set<string>();
  const recentTokens = { value: 0 };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (anchorIds.has(msg.id)) continue;
    const before = recent.length;
    addMessageWithinBudget(recent, recentIds, msg, recentBudget, recentTokens);
    if (recent.length === before && recentTokens.value >= recentBudget) break;
  }
  recent.reverse();

  const idOrder = new Map(messages.map((msg, index) => [msg.id, index]));
  const ordered = [...anchors, ...recent]
    .sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
  const seen = new Set<string>();
  const deduped = ordered.filter((msg) => {
    if (seen.has(msg.id)) return false;
    seen.add(msg.id);
    return true;
  });

  const anchorSection = anchors.length
    ? `## Milestone and Decision Anchors\n${anchors.map(renderMessageForSummary).join('\n\n')}`
    : '## Milestone and Decision Anchors\n(none)';
  const recentSection = recent.length
    ? `## Recent Transcript\n${recent.map(renderMessageForSummary).join('\n\n')}`
    : '## Recent Transcript\n(none)';

  return {
    transcript: `${anchorSection}\n\n${recentSection}`,
    selectedMessageIds: deduped.map((msg) => msg.id),
    anchorMessageIds: anchors.map((msg) => msg.id),
    tokenBudget,
  };
}

/**
 * Build a per-loop LLM summarizer for L4 context compression.
 * Passing this into compaction avoids storing provider credentials on the
 * ContextCompressor singleton, where concurrent loops could overwrite them.
 */
export function createAgentLoopSummarizer(config: AgentLoopSummarizerConfig): SummarizerFn {
  return async (msgs: Message[], budget: number): Promise<string> => {
    const provider = createLLMProvider(config.provider, extensionPoints);
    const sysPrompt = ContextCompressor.getInstance().structuredSummaryPrompt;
    const { transcript } = buildFocusedSummarizerTranscript(
      msgs,
      config.contextWindow,
      budget,
    );
    const maxTokens = Math.max(
      256,
      Math.min(budget, SUMMARY_MAX_TOKENS, Math.floor(config.contextWindow * 0.16)),
    );

    const stream = provider.chat(
      [{ role: 'user', content: transcript }],
      [],
      sysPrompt,
      {
        model: config.modelName,
        maxTokens,
        temperature: 0.3,
        contextWindow: config.contextWindow,
        apiUrl: config.apiUrl || '',
        apiKey: config.apiKey || '',
      },
    );

    let summary = '';
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        summary += event.content || '';
      }
    }
    return summary;
  };
}
