import type {
  CapabilityInputField,
  CapabilityRecord,
  TaskResolveCandidate,
  TaskResolveRequest,
  TaskResolveResult,
} from '../../../shared/types/capability.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';

const MIN_CAPABILITY_SCORE = 6;

const CREATE_INTENT_TERMS = [
  'create',
  'make',
  'generate',
  'build',
  'write',
  'produce',
  '制作',
  '生成',
  '创建',
  '做',
  '写',
  '整理',
  '分析',
  '总结',
  '规划',
];

export class TaskResolver {
  constructor(private readonly _capabilities = CapabilityRegistry.getInstance()) {}

  async resolve(request: TaskResolveRequest): Promise<TaskResolveResult> {
    const query = (request.message || '').trim();
    if (!query) return emptyResult(query, 'Empty message');

    const { capabilities } = await this._capabilities.allCapabilities({
      includeUnavailable: request.includeUnavailable !== false,
      limit: 500,
    });
    const candidates = capabilities
      .map((capability) => scoreCapability(capability, query))
      .filter((candidate) => candidate.score > 0)
      .sort(compareCandidates)
      .slice(0, 8);

    const best = candidates[0];
    if (!best || best.score < MIN_CAPABILITY_SCORE) {
      return {
        intent: 'chat',
        query,
        confidence: 0.2,
        nextAction: 'chat',
        canStart: true,
        candidates,
        missingInputs: [],
        missingTools: [],
        recommendedPlugins: [],
        assumptions: [],
        reason: 'No user-level capability matched strongly enough.',
        suggestedResponse: 'I can answer directly, or you can ask me to create, analyze, organize, research, or automate something.',
      };
    }

    const capability = best.capability;
    const missingInputs = best.missingInputs;
    const recommendedPlugins = unique([
      ...(capability.recommendedPlugins || []),
      ...(capability.status === 'disabled' && capability.pluginName ? [capability.pluginName] : []),
    ]);
    const canStart = capability.status === 'available' && missingInputs.length === 0;
    const nextAction = chooseNextAction(capability, missingInputs);

    return {
      intent: 'capability',
      query,
      confidence: best.confidence,
      nextAction,
      canStart,
      bestCapability: capability,
      candidates,
      missingInputs,
      missingTools: capability.missingTools,
      recommendedPlugins,
      assumptions: buildAssumptions(capability),
      reason: buildReason(capability, best),
      suggestedResponse: buildSuggestedResponse(capability, nextAction, missingInputs, recommendedPlugins),
    };
  }
}

function scoreCapability(capability: CapabilityRecord, query: string): TaskResolveCandidate {
  const normalizedQuery = normalize(query);
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const trigger of capability.triggers || []) {
    const term = normalize(trigger);
    if (!term) continue;
    if (normalizedQuery.includes(term)) {
      matchedTerms.add(trigger);
      score += 10 + Math.min(6, Math.ceil(term.length / 3));
    }
  }

  for (const term of keywordTerms(capability)) {
    if (term.length < 3) continue;
    if (normalizedQuery.includes(term)) {
      matchedTerms.add(term);
      score += 2;
    }
  }

  for (const output of capability.outputs || []) {
    const extension = normalize(output.extension || '');
    const artifactType = normalize(output.artifactType || '');
    if (extension && normalizedQuery.includes(extension)) {
      matchedTerms.add(extension);
      score += 6;
    }
    if (artifactType && normalizedQuery.includes(artifactType)) {
      matchedTerms.add(artifactType);
      score += 3;
    }
  }

  if (hasCreateIntent(normalizedQuery) && capability.kind === 'artifact') score += 2;
  if (capability.status === 'available') score += 2;
  if (capability.status === 'error') score -= 3;

  const missingInputs = requiredMissingInputs(capability, query);
  const confidence = Math.max(0.05, Math.min(0.98, score / 28));

  return {
    capability,
    score,
    confidence,
    matchedTerms: Array.from(matchedTerms),
    missingInputs,
  };
}

function keywordTerms(capability: CapabilityRecord): string[] {
  return [
    capability.id,
    capability.title,
    capability.domain,
    capability.description || '',
    ...(capability.examples || []),
    ...(capability.artifactTypes || []),
  ]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(Boolean);
}

function requiredMissingInputs(capability: CapabilityRecord, query: string): CapabilityInputField[] {
  const normalizedQuery = normalize(query);
  return (capability.inputs || []).filter((input) => {
    if (!input.required) return false;
    if (input.defaultValue !== undefined) return false;
    if (isPrimaryFreeformInput(input.name) && query.trim().length > 0) return false;
    const aliases = [input.name, input.label || '', ...(input.aliases || [])].map(normalize).filter(Boolean);
    return !aliases.some((alias) => normalizedQuery.includes(alias));
  });
}

function chooseNextAction(capability: CapabilityRecord, missingInputs: CapabilityInputField[]): TaskResolveResult['nextAction'] {
  if (capability.status === 'needs_plugin' || capability.status === 'disabled' || capability.status === 'unavailable') {
    return 'recommend_plugin';
  }
  if (missingInputs.length > 0) return 'ask_user';
  return 'execute_capability';
}

function buildReason(capability: CapabilityRecord, candidate: TaskResolveCandidate): string {
  const matched = candidate.matchedTerms.length > 0 ? ` Matched: ${candidate.matchedTerms.join(', ')}.` : '';
  return `Resolved to ${capability.id} (${capability.status}).${matched}`;
}

function buildAssumptions(capability: CapabilityRecord): string[] {
  const assumptions: string[] = [];
  for (const input of capability.inputs || []) {
    if (input.defaultValue !== undefined) {
      assumptions.push(`${input.label || input.name}: ${String(input.defaultValue)}`);
    }
  }
  return assumptions;
}

function buildSuggestedResponse(
  capability: CapabilityRecord,
  nextAction: TaskResolveResult['nextAction'],
  missingInputs: CapabilityInputField[],
  recommendedPlugins: string[],
): string {
  if (nextAction === 'execute_capability') {
    return `I found the "${capability.title}" capability and can start now.`;
  }
  if (nextAction === 'ask_user') {
    const names = missingInputs.map((input) => input.label || input.name).join(', ');
    return `I found the "${capability.title}" capability. I need: ${names}.`;
  }
  const plugins = recommendedPlugins.length > 0 ? recommendedPlugins.join(', ') : 'a plugin that provides this capability';
  return `This looks like "${capability.title}", but the required capability is not ready yet. Recommended plugin: ${plugins}.`;
}

function compareCandidates(a: TaskResolveCandidate, b: TaskResolveCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const availabilityRank = (candidate: TaskResolveCandidate) => candidate.capability.status === 'available' ? 0 : 1;
  const availability = availabilityRank(a) - availabilityRank(b);
  if (availability !== 0) return availability;
  return (b.capability.priority || 0) - (a.capability.priority || 0);
}

function emptyResult(query: string, reason: string): TaskResolveResult {
  return {
    intent: 'unknown',
    query,
    confidence: 0,
    nextAction: 'chat',
    canStart: false,
    candidates: [],
    missingInputs: [],
    missingTools: [],
    recommendedPlugins: [],
    assumptions: [],
    reason,
    suggestedResponse: 'Tell me what you want AnoClaw to create, analyze, organize, research, or automate.',
  };
}

function hasCreateIntent(query: string): boolean {
  return CREATE_INTENT_TERMS.some((term) => query.includes(normalize(term)));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPrimaryFreeformInput(name: string): boolean {
  return ['topic', 'content', 'query', 'text', 'prompt', 'description'].includes(name);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
