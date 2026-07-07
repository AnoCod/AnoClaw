// MemoryLifecycle.ts — Post-session memory lifecycle management
// Handles: semantic extraction, RecMem-style consolidation, Ebbinghaus decay, 4-tier pruning.
//
// Invoked from AgentLoop after completion and on session close.

import { MemoryManager } from '../MemoryManager.js';
import { MemoryScope, MemoryType, MemoryCategory, defaultCategory } from '../MemoryEntry.js';
import type { MemoryEntry } from '../MemoryEntry.js';
import { createLogger } from '../../logger.js';
import type { LLMOptions } from '../../../../shared/types/llm.js';
import { loadAgentConfig } from '../../agent/AgentConfig.js';

const logger = createLogger('anochat.memory.lifecycle');
const log = (msg: string, ...args: any[]) => {
  logger.info(msg, ...args);
};

// ─── Constants ─────────────────────────────────────────────────

const HALF_LIFE_HOURS: Record<string, number> = {
  user: 365 * 24,       // 365 days for user profile info
  project: 90 * 24,     // 90 days for project decisions
  reference: 30 * 24,   // 30 days for reference info
  feedback: 14 * 24,    // 14 days for feedback
};

const QUANTIZATION_TIERS = {
  active: { minStrength: 0.3, label: 'active' },
  warm: { minStrength: 0.1, label: 'warm' },
  cold: { minStrength: 0.05, label: 'cold' },
  archive: { minStrength: 0, label: 'archive' },
} as const;

const SIMILARITY_THRESHOLD = 0.85;   // Cosine threshold for dedup/merge
const MIN_MERGE_COUNT = 2;            // Trigger consolidation after N similar memories

// ─── Decay ─────────────────────────────────────────────────────

/** Compute memory strength from access pattern and time elapsed. */
export function computeMemoryStrength(entry: MemoryEntry, now: number = Date.now()): number {
  const lastAccess = entry.updatedAt || now;
  const hoursSinceAccess = Math.max(0, (now - lastAccess) / (1000 * 60 * 60));
  const halfLife = HALF_LIFE_HOURS[entry.type] || 14 * 24;

  // Ebbinghaus decay: strength = e^(-hours * ln2 / half_life)
  const decay = Math.exp(-hoursSinceAccess * Math.log(2) / halfLife);

  // Frequency boost: log2(1 + access_count) / 10, capped at 0.15
  const accessCount = (entry as any).accessCount || 0;
  const freqBoost = Math.min(0.15, Math.log2(1 + accessCount) / 10);

  // Importance base: default 0.5
  const importance = (entry as any).importance || 0.5;

  return Math.min(1, importance * decay + freqBoost);
}

/** Get the quantization tier for a given strength score. */
export function getQuantizationTier(strength: number): string {
  if (strength >= QUANTIZATION_TIERS.active.minStrength) return 'active';
  if (strength >= QUANTIZATION_TIERS.warm.minStrength) return 'warm';
  if (strength >= QUANTIZATION_TIERS.cold.minStrength) return 'cold';
  return 'archive';
}

// ─── Consolidation ─────────────────────────────────────────────

/**
 * Check if there are similar memories that should be consolidated.
 * Returns groups of similar entries (cosine > threshold on content using word overlap as proxy).
 */
export function findConsolidationGroups(entries: MemoryEntry[], threshold: number = SIMILARITY_THRESHOLD): MemoryEntry[][] {
  if (entries.length < MIN_MERGE_COUNT) return [];

  const groups: MemoryEntry[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const group: MemoryEntry[] = [entries[i]];
    const aWords = new Set(tokenize(entries[i].content));

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      if (entries[i].type !== entries[j].type) continue; // Only merge same type

      const bWords = new Set(tokenize(entries[j].content));
      const intersection = [...aWords].filter(w => bWords.has(w)).length;
      const union = new Set([...aWords, ...bWords]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard >= threshold) {
        group.push(entries[j]);
        used.add(j);
      }
    }

    if (group.length >= MIN_MERGE_COUNT) {
      groups.push(group);
      used.add(i);
    }
  }

  return groups;
}

/**
 * Build the consolidation prompt for a group of similar memories.
 */
export function buildConsolidationPrompt(group: MemoryEntry[]): { systemPrompt: string; userPrompt: string; topic: string } {
  const memoryList = group.map((e, i) =>
    `[${i + 1}] Name: ${e.name}\nType: ${e.type}\nContent: ${e.content}`
  ).join('\n\n');
  const topic = group[0].name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);

  const systemPrompt = 'You are a memory consolidation assistant. Your task is to merge related memories. Output ONLY the consolidated markdown content — no preamble, no explanation, no "Consolidated:" prefix.';
  const userPrompt = `Consolidate these related memories into one comprehensive memory. Keep all unique facts. Remove redundant information. Merge complementary details into a cohesive summary.

${memoryList}

Consolidated memory (output only the content):`;

  return { systemPrompt, userPrompt, topic };
}

/**
 * Call LLM to consolidate a group of memories. Returns the consolidated text or null.
 */
async function callLLMForConsolidation(
  userPrompt: string,
  systemPrompt: string,
  agentId: string,
): Promise<string | null> {
  let config;
  try {
    config = await loadAgentConfig(agentId);
  } catch {
    const { defaultConfig } = await import('../../agent/AgentConfig.js');
    config = defaultConfig();
    logger.warn('callLLMForConsolidation: failed to load agent config, using default', { agentId });
  }

  if (!config.apiKey && !config.apiUrl) {
    logger.info('callLLMForConsolidation: no API credentials available, skipping consolidation');
    return null;
  }

  const { createLLMProvider } = await import('../../../infra/llm/provider-factory.js');
  const provider = createLLMProvider(config.provider || 'cloud_api');

  const llmOptions: LLMOptions = {
    model: config.model || 'deepseek-chat',
    maxTokens: 4096,
    temperature: 0.3,
    contextWindow: config.contextWindow || 128000,
    apiUrl: config.apiUrl || '',
    apiKey: config.apiKey || '',
  };

  const messages = [{ role: 'user' as const, content: userPrompt }];
  const stream = provider.chat(messages, [], systemPrompt, llmOptions);
  let consolidatedContent = '';
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      consolidatedContent += event.content || '';
    }
  }

  if (!consolidatedContent.trim()) {
    logger.info('callLLMForConsolidation: LLM returned empty content');
    return null;
  }

  return consolidatedContent.trim();
}

/**
 * Create a consolidated memory entry from merged content.
 */
async function createConsolidatedEntry(
  group: MemoryEntry[],
  content: string,
  topic: string,
  agentId: string,
): Promise<MemoryEntry> {
  const mm = MemoryManager.getInstance();
  const entry: MemoryEntry = {
    name: `consolidated-${topic}`,
    type: group[0].type,
    description: `Consolidated memory from ${group.length} similar entries`,
    content,
    scope: group[0].scope || MemoryScope.Agent,
    category: group[0].category || defaultCategory(group[0].type),
  };

  await mm.save(agentId, entry.scope, entry);
  return entry;
}

/**
 * Use an LLM to merge a group of similar memories into one consolidated memory.
 * The old entries remain as-is. A new consolidated entry is created with
 * a summary that keeps all unique facts and removes redundant information.
 *
 * Best-effort: returns null if LLM call fails, returns empty, or save fails.
 */
export async function consolidateGroup(
  group: MemoryEntry[],
  agentId: string,
): Promise<MemoryEntry | null> {
  if (group.length < 2) return null;

  try {
    const { systemPrompt, userPrompt, topic } = buildConsolidationPrompt(group);
    const consolidatedContent = await callLLMForConsolidation(userPrompt, systemPrompt, agentId);
    if (!consolidatedContent) return null;

    const entry = await createConsolidatedEntry(group, consolidatedContent, topic, agentId);
    logger.info('consolidateGroup: created consolidated memory', {
      name: entry.name,
      sourceCount: group.length,
      agentId,
    });

    return entry;
  } catch (err) {
    logger.warn('consolidateGroup: consolidation failed (best-effort, continuing)', {
      error: (err as Error).message,
      agentId,
    });
    return null;
  }
}

// ─── Session-Close Lifecycle ───────────────────────────────────

/**
 * Run post-session memory lifecycle: extract, consolidate, decay, prune.
 * Called from AgentLoop on completion. Non-blocking, fire-and-forget.
 */
export async function runSessionCloseLifecycle(
  agentId: string,
  sessionId: string,
  messages: Array<{ role: string; content: string | unknown }>,
): Promise<void> {
  try {
    const mm = MemoryManager.getInstance();

    // 1. Auto-extract facts from conversation
    const extracted = await mm.autoExtract(agentId, messages);
    if (extracted > 0) log(`auto-extracted ${extracted} facts from session ${sessionId}`);

    // 2. Decay all agent memories
    const agentEntries = await mm.search(agentId, MemoryScope.Agent, '');
    const teamEntries = await mm.search(agentId, MemoryScope.Team, '');
    const allEntries = [...agentEntries, ...teamEntries];

    const now = Date.now();
    let pruned = 0;
    for (const e of allEntries) {
      const strength = computeMemoryStrength(e, now);
      const tier = getQuantizationTier(strength);

      if (tier === 'archive') {
        // Prune archived entries from active storage
        try {
          await mm.remove(agentId, e.scope || MemoryScope.Agent, e.name);
          pruned++;
        } catch { /* entry may already be gone */ }
      }
    }
    if (pruned > 0) log(`pruned ${pruned} archived memories`);

    // 3. Consolidate similar memories via LLM summarization
    const groups = findConsolidationGroups(allEntries);
    for (const group of groups) {
      try {
        const consolidated = await consolidateGroup(group, agentId);
        if (consolidated) {
          log(`consolidated ${group.length} memories into: ${consolidated.name}`);
        }
      } catch {
        // Consolidation is best-effort — never break the lifecycle
      }
    }
  } catch (err) {
    log('lifecycle error', (err as Error).message);
    // Never throw — this is a post-loop cleanup task
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length >= 2);
}
