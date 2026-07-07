// SkillFromTools — LLM-driven semantic skill generation from conversation transcripts.
// Sends transcript + tool call summaries to an LLM which produces a complete SKILL.md
// with YAML frontmatter (name, description, when_to_use, triggers, priority).
// Simple one-off tasks return null (LLM responds with "SKIP").
//
// Trigger threshold: ≥6 messages OR ≥3 tool calls.
//
// LLM calling pattern mirrors AgentLoopLLM.callLLMWithRetry:
//   - extensionPoints for plugin provider overrides
//   - APIScheduler for rate limiting
//   - Exponential backoff retry with error classification
//   - No SSE streaming — we only need the final text

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import type { LLMOptions, LLMStreamEvent } from '../../../shared/types/llm.js';
import { APIScheduler } from '../../infra/llm/APIScheduler.js';
import { createLogger } from '../logger.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { estimateTokens } from '../agent/AgentLoopHelpers.js';
import {
  MAX_API_RETRIES,
  API_BACKOFF_BASE_MS,
  API_BACKOFF_MAX_MS,
} from '../../../shared/constants.js';

// ── Prompt templates ──

const SKILL_GEN_SYSTEM_PROMPT = `You are a skill generator for AnoClaw, an AI coding assistant. Analyze conversation transcripts and tool call patterns to create reusable SKILL.md definitions.

OUTPUT FORMAT — A SKILL.md file with YAML frontmatter:

---
name: kebab-case-name
description: One-line description of what this skill does
when_to_use: |
  Detailed natural-language description of WHEN this skill should be triggered.
  Include specific scenarios, keywords, and context clues.
triggers:
  - "keyword1"
  - "keyword2"
priority: 60
---

# Skill Name

Step-by-step workflow or instructions for executing this skill.
Break into numbered steps with clear actions.

RULES:
1. CRITICAL — If the task is a SIMPLE ONE-OFF (single operation, trivial query, no reusable pattern, no multi-step workflow), respond with EXACTLY one word: SKIP
2. name: kebab-case, descriptive, unique. Prefix with domain (e.g. "git-", "code-", "browser-", "api-")
3. description: one line, clear, describes WHAT the skill accomplishes
4. when_to_use: natural language describing triggering scenarios. Be specific — mention file types, error messages, user intents, project contexts
5. triggers: 2-5 specific keywords/phrases that indicate this skill should be suggested
6. priority: 90-100 = critical/frequent workflows, 50-80 = common patterns, 10-40 = niche/rare
7. Body: actionable numbered steps. Each step should be concrete ("Run git status", not "Check the repository")
8. Respond with ONLY the SKILL.md content (starting with "---") or the word "SKIP". No explanations, no markdown code fences.`;

// ── Error classification (same regex sets as AgentLoopLLM) ──

const RETRYABLE: RegExp[] = [
  /429|rate.?limit|too many requests|busy|overloaded|throttled/i,
  /5\d\d|server.*error|internal.*error|bad gateway|service.*unavailable|temporarily.*unavailable|maintenance/i,
  /network|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|socket|timeout|fetch.*failed|abort|connection|timeout/i,
  /overloaded|capacity|busy|congestion/i,
];
const UNRETRYABLE: RegExp[] = [
  /40[0-9]|bad.?request|invalid|tool.*must|message.*role|not.?found|unauthorized|forbidden|payment|quota|billing/i,
];

// ── Helpers ──

/**
 * Build a concise conversation summary from transcript messages.
 * Extracts user intents, key actions, and outcomes.
 */
function buildTranscriptSummary(
  transcript: unknown[],
  toolCalls: Array<{ name: string; result?: string }>,
): string {
  const lines: string[] = ['## Conversation Analysis', ''];

  // Extract user messages
  const userMessages: string[] = [];
  for (const msg of transcript) {
    if (typeof msg === 'object' && msg !== null) {
      const m = msg as Record<string, unknown>;
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        userMessages.push(m.content.trim());
      }
    }
  }

  if (userMessages.length > 0) {
    lines.push('### User Requests');
    for (let i = 0; i < Math.min(userMessages.length, 5); i++) {
      const truncated = userMessages[i].length > 200
        ? userMessages[i].slice(0, 200) + '...'
        : userMessages[i];
      lines.push(`${i + 1}. ${truncated}`);
    }
    lines.push('');
  }

  // Tool call sequence
  if (toolCalls.length > 0) {
    lines.push('### Tool Call Sequence');
    const seen = new Set<string>();
    for (const tc of toolCalls) {
      const name = tc.name || 'unknown';
      if (seen.has(name)) continue;
      seen.add(name);
      const resultSummary = tc.result
        ? ` — ${tc.result.slice(0, 80)}`
        : '';
      lines.push(`- \`${name}\`${resultSummary}`);
    }
    lines.push('');
  }

  // Task characteristics
  lines.push('### Task Characteristics');
  lines.push(`- Total messages: ${transcript.length}`);
  lines.push(`- Unique tools used: ${new Set(toolCalls.map(tc => tc.name)).size}`);
  lines.push(`- Total tool calls: ${toolCalls.length}`);
  lines.push(`- Multi-step: ${toolCalls.length >= 3 ? 'Yes' : 'No'}`);

  return lines.join('\n');
}

/**
 * Call LLM for skill generation with retry, rate limiting, and plugin overrides.
 * Mirrors AgentLoopLLM.callLLMWithRetry patterns:
 *   - extensionPoints for plugin provider overrides
 *   - APIScheduler.acquireSlot() for rate limiting
 *   - Exponential backoff: base 1s, max 60s, up to MAX_API_RETRIES attempts
 *   - Error classification: retryable (429/5xx/network) vs unretryable (4xx/auth/quota)
 *
 * Unlike the agent loop, this does NOT stream SSE events — it collects the full
 * response text and returns it. No tool calls are expected from the skill-gen LLM.
 */
async function callLLMForSkillGen(
  config: { model: string; apiUrl: string; apiKey: string },
  summary: string,
  signal?: AbortSignal,
): Promise<string> {
  const RETRY_MAX = MAX_API_RETRIES;
  const log = createLogger('anochat.core');
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (signal?.aborted) throw new Error('Skill generation aborted');

    if (attempt > 0) {
      const delay = Math.min(
        API_BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 500,
        API_BACKOFF_MAX_MS,
      );
      log.debug('Skill gen retry', { attempt: attempt + 1, delayMs: Math.round(delay) });
      await new Promise(r => setTimeout(r, delay));
      if (signal?.aborted) throw new Error('Skill generation aborted');
    }

    try {
      // Plugin-aware provider (same pattern as AgentLoopLLM)
      const provider = createLLMProvider('openai-compatible', extensionPoints);
      const llmOptions: LLMOptions = {
        model: config.model,
        maxTokens: 4096,
        temperature: 0.3,
        contextWindow: 128000,
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
      };

      // Rate limiting (same pattern as AgentLoopLLM)
      const estimatedInputTokens = estimateTokens([{ role: 'user', content: summary }]);
      const estimatedTotal = estimatedInputTokens + llmOptions.maxTokens;
      await APIScheduler.getInstance().acquireSlot(config.apiKey || '', estimatedTotal);

      const messages = [{ role: 'user' as const, content: summary }];
      const stream: AsyncGenerator<LLMStreamEvent> = provider.chat(
        messages,
        [], // no tools needed for skill generation
        SKILL_GEN_SYSTEM_PROMPT,
        llmOptions,
        signal,
      );

      let fullText = '';
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          fullText += event.content || '';
        }
        if (event.type === 'error') {
          throw new Error(event.errorMessage || 'LLM stream error during skill generation');
        }
      }

      return fullText.trim();
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      const errMsg = err.message || '';
      lastErr = err;

      log.warn('Skill gen LLM attempt failed', {
        attempt: attempt + 1,
        error: errMsg.slice(0, 200),
      });

      // Permanent errors — fail immediately
      if (UNRETRYABLE.some(r => r.test(errMsg))) {
        throw err;
      }

      // Retryable — continue to next attempt
      if (attempt < RETRY_MAX && RETRYABLE.some(r => r.test(errMsg))) {
        continue;
      }

      // Unknown error at last attempt — throw
      throw err;
    }
  }

  throw lastErr || new Error('All skill gen retries exhausted');
}

// ── Main entry: LLM-driven skill generation ──

export interface SkillGenLLMOptions {
  model: string;
  apiUrl: string;
  apiKey: string;
}

function resolveLLMOptions(provided?: SkillGenLLMOptions): SkillGenLLMOptions {
  if (provided?.model && provided?.apiUrl && provided?.apiKey) return provided;
  const settings = SettingsManager.getInstance();
  return {
    model: settings.get<string>('llm.model', 'deepseek-chat'),
    apiUrl: settings.get<string>('llm.apiUrl', 'https://api.deepseek.com'),
    apiKey: settings.get<string>('llm.apiKey', ''),
  };
}

/**
 * Analyze a conversation transcript using LLM semantic understanding and generate
 * a complete SKILL.md when a reusable multi-step pattern is detected.
 *
 * @param transcript       — conversation messages
 * @param toolCalls        — tool calls with names and optional result snippets
 * @param llmOptions       — LLM connection config (model, apiUrl, apiKey). Auto-reads from SettingsManager if omitted.
 * @param projectSkillsDir — target directory for generated SKILL.md files
 * @returns { skillName, content } or null if below threshold / LLM returned SKIP
 */
export async function generateSkillFromTranscript(
  transcript: unknown[],
  toolCalls: Array<{ name: string; result?: string }>,
  llmOptions?: SkillGenLLMOptions,
  projectSkillsDir?: string,
): Promise<{ skillName: string; content: string } | null> {
  // Relaxed trigger: ≥6 messages OR ≥3 tool calls
  const msgCount = transcript?.length ?? 0;
  const toolCount = toolCalls?.length ?? 0;
  if (msgCount < 6 && toolCount < 3) return null;

  const resolvedOpts = resolveLLMOptions(llmOptions);
  const summary = buildTranscriptSummary(transcript, toolCalls);

  let responseText: string;
  try {
    responseText = await callLLMForSkillGen(
      {
        model: resolvedOpts.model,
        apiUrl: resolvedOpts.apiUrl,
        apiKey: resolvedOpts.apiKey,
      },
      summary,
    );
  } catch (err) {
    createLogger('anochat.core').warn('LLM skill generation failed', {
      error: (err as Error).message?.slice(0, 200),
    });
    return null;
  }

  // LLM indicated simple task — no skill needed
  if (!responseText || responseText.toUpperCase() === 'SKIP') return null;

  // Strip code fences if LLM wrapped it
  let content = responseText;
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:yaml|markdown|md)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }

  // Validate basic structure
  if (!content.startsWith('---')) {
    createLogger('anochat.core').warn('LLM skill generation: invalid output format', {
      preview: content.slice(0, 100),
    });
    return null;
  }

  // Extract name from frontmatter for directory naming
  const nameMatch = content.match(/^---\n[\s\S]*?\nname:\s*(\S+)/m);
  const skillName = nameMatch?.[1]?.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
    || `auto-skill-${Date.now().toString(36)}`;

  // Write to disk
  const skillsDir = projectSkillsDir || path.resolve(process.cwd(), 'skills');
  const skillDir = path.join(skillsDir, skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  // Atomically create file — fail if it already exists (avoids TOCTOU race)
  try {
    await fs.writeFile(skillMdPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      createLogger('anochat.core').info('Skill already exists, skipping generation', { skill: skillName });
      return null;
    }
    throw err;
  }
  createLogger('anochat.core').info('LLM-generated skill created', { skill: skillName });

  return { skillName, content };
}

// ── Legacy wrapper: backward-compat with old rule-based API ──

/**
 * @deprecated Use generateSkillFromTranscript() for LLM-based generation.
 * This wrapper auto-reads LLM config from SettingsManager and delegates.
 */
export async function generateSkillFromTools(
  transcript: unknown[],
  toolCalls?: Array<{ name: string; result?: string }>,
  projectSkillsDir?: string,
  onGenerated?: (skillName: string) => Promise<void>,
): Promise<string | null> {
  if (!transcript || !toolCalls) return null;

  const result = await generateSkillFromTranscript(
    transcript,
    toolCalls,
    undefined, // auto-read from SettingsManager
    projectSkillsDir,
  );

  if (result && onGenerated) {
    await onGenerated(result.skillName);
  }

  return result?.skillName ?? null;
}
