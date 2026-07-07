import type {
  CapabilityInputField,
  CapabilityRecord,
  TaskResolveCandidate,
  TaskResolveRequest,
  TaskResolveResult,
  UserMode,
} from '../../../shared/types/capability.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';
import { CapabilityPluginRecommender } from './CapabilityPluginRecommender.js';

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
  constructor(
    private readonly _capabilities = CapabilityRegistry.getInstance(),
    private readonly _pluginRecommender = new CapabilityPluginRecommender(),
  ) {}

  async resolve(request: TaskResolveRequest): Promise<TaskResolveResult> {
    const query = (request.message || '').trim();
    const userMode = normalizeUserMode(request.userMode);
    if (!query) return emptyResult(query, 'Empty message', userMode, request.locale);

    const { capabilities } = await this._capabilities.allCapabilities({
      includeUnavailable: request.includeUnavailable !== false,
      limit: 500,
    });
    const candidates = capabilities
      .map((capability) => scoreCapability(capability, query, userMode))
      .filter((candidate) => candidate.score > 0)
      .sort(compareCandidates)
      .slice(0, 8);

    const best = candidates[0];
    if (!best || best.score < MIN_CAPABILITY_SCORE) {
      return {
        intent: 'chat',
        query,
        userMode,
        locale: request.locale,
        confidence: 0.2,
        nextAction: 'chat',
        canStart: true,
        candidates,
        missingInputs: [],
        missingTools: [],
        recommendedPlugins: [],
        pluginRecommendations: [],
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
    const pluginRecommendations = await this._pluginRecommender.recommend({
      capability,
      recommendedPlugins,
      missingTools: capability.missingTools,
    });

    return {
      intent: 'capability',
      query,
      userMode,
      locale: request.locale,
      confidence: best.confidence,
      nextAction,
      canStart,
      bestCapability: capability,
      candidates,
      missingInputs,
      missingTools: capability.missingTools,
      recommendedPlugins,
      pluginRecommendations,
      assumptions: buildAssumptions(capability),
      reason: buildReason(capability, best),
      suggestedResponse: buildSuggestedResponse(capability, nextAction, missingInputs, recommendedPlugins, pluginRecommendations),
    };
  }
}

function scoreCapability(capability: CapabilityRecord, query: string, userMode: UserMode): TaskResolveCandidate {
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
  score += userModeScoreBoost(capability, userMode);
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
  pluginRecommendations: TaskResolveResult['pluginRecommendations'],
): string {
  if (nextAction === 'execute_capability') {
    return `I found the "${capability.title}" capability and can start now.`;
  }
  if (nextAction === 'ask_user') {
    const names = missingInputs.map((input) => input.label || input.name).join(', ');
    return `I found the "${capability.title}" capability. I need: ${names}.`;
  }
  const pluginNames = pluginRecommendations.length > 0
    ? pluginRecommendations.map((plugin) => plugin.displayName || plugin.pluginName)
    : recommendedPlugins;
  const plugins = pluginNames.length > 0 ? pluginNames.join(', ') : 'a plugin that provides this capability';
  return `This looks like "${capability.title}", but the required capability is not ready yet. Recommended plugin: ${plugins}.`;
}

function compareCandidates(a: TaskResolveCandidate, b: TaskResolveCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const availabilityRank = (candidate: TaskResolveCandidate) => candidate.capability.status === 'available' ? 0 : 1;
  const availability = availabilityRank(a) - availabilityRank(b);
  if (availability !== 0) return availability;
  return (b.capability.priority || 0) - (a.capability.priority || 0);
}

function emptyResult(query: string, reason: string, userMode: UserMode, locale?: string): TaskResolveResult {
  return {
    intent: 'unknown',
    query,
    userMode,
    locale,
    confidence: 0,
    nextAction: 'chat',
    canStart: false,
    candidates: [],
    missingInputs: [],
    missingTools: [],
    recommendedPlugins: [],
    pluginRecommendations: [],
    assumptions: [],
    reason,
    suggestedResponse: 'Tell me what you want AnoClaw to create, analyze, organize, research, or automate.',
  };
}

function normalizeUserMode(value: unknown): UserMode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'office' || raw === 'work') return 'office';
  if (raw === 'coding' || raw === 'programming' || raw === 'developer' || raw === 'dev') return 'coding';
  if (raw === 'child' || raw === 'kids' || raw === 'education') return 'child';
  if (raw === 'professional' || raw === 'pro' || raw === 'expert') return 'professional';
  return 'simple';
}

function userModeScoreBoost(capability: CapabilityRecord, userMode: UserMode): number {
  if (userMode === 'office') {
    if (['office', 'pdf', 'data'].includes(capability.domain)) return 4;
    if (capability.artifactTypes?.some((type) => ['presentation', 'document', 'spreadsheet', 'report'].includes(type))) return 2;
  }
  if (userMode === 'child') {
    if (capability.domain === 'education') return 5;
    if (capability.id.startsWith('education.')) return 5;
    if (capability.kind === 'knowledge') return 1;
  }
  if (userMode === 'coding') {
    if (capability.domain === 'coding') return 6;
    if (capability.kind === 'automation' || capability.domain === 'files') return 1;
  }
  if (userMode === 'professional') {
    if (capability.domain === 'coding') return 5;
    if (['automation', 'memory', 'files'].includes(capability.domain)) return 2;
    if (capability.kind === 'automation' || capability.kind === 'utility') return 2;
  }
  if (userMode === 'simple' && capability.kind === 'artifact') return 1;
  return 0;
}

function hasCreateIntent(query: string): boolean {
  return CREATE_INTENT_TERMS.some((term) => query.includes(normalize(term)));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPrimaryFreeformInput(name: string): boolean {
  return ['topic', 'title', 'subject', 'content', 'query', 'text', 'prompt', 'description'].includes(name);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
