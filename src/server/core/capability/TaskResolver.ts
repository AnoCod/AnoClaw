import type {
  CapabilityInputField,
  CapabilityRecord,
  TaskResolveCandidate,
  TaskResolveRequest,
  TaskResolveResult,
  TaskResolveToolCallSuggestion,
} from '../../../shared/types/capability.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';
import { CapabilityPluginRecommender } from './CapabilityPluginRecommender.js';

const MIN_CAPABILITY_SCORE = 6;

const CODE_FILE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.css',
  '.scss',
  '.html',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
];

const CODE_GLOB_PATTERN = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,cpp,c,h,hpp,css,scss,html,vue,svelte,json,yaml,yml,toml,md}';

export class TaskResolver {
  constructor(
    private readonly _capabilities = CapabilityRegistry.getInstance(),
    private readonly _pluginRecommender = new CapabilityPluginRecommender(),
  ) {}

  async resolve(request: TaskResolveRequest): Promise<TaskResolveResult> {
    const query = (request.message || '').trim();
    if (!query) return emptyResult(query, 'Empty message', request.locale);

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
    const suggestedToolCall = buildSuggestedToolCall(capability, query, missingInputs, nextAction);

    return {
      intent: 'capability',
      query,
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
      suggestedToolCall,
      assumptions: buildAssumptions(capability),
      reason: buildReason(capability, best),
      suggestedResponse: buildSuggestedResponse(capability, nextAction, missingInputs, recommendedPlugins, pluginRecommendations),
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
    if (extension && normalizedQuery.includes(extension)) {
      matchedTerms.add(extension);
      score += 6;
    }
  }

  const fileTypeBoost = explicitFileTypeBoost(capability, normalizedQuery);
  if (fileTypeBoost > 0) score += fileTypeBoost;

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
  ]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter(Boolean);
}

function explicitFileTypeBoost(capability: CapabilityRecord, normalizedQuery: string): number {
  const outputTypes = new Set<string>();
  for (const output of capability.outputs || []) {
    if (output.type) outputTypes.add(normalize(output.type));
    if (output.extension) outputTypes.add(normalize(output.extension));
  }
  outputTypes.add(normalize(capability.domain));

  let score = 0;
  for (const type of outputTypes) {
    if (!type) continue;
    if (normalizedQuery.includes(`.${type}`)) score += 10;
  }
  if (outputTypes.has('pdf') && /\bpdf\b|\.pdf\b/.test(normalizedQuery)) score += 6;
  if (outputTypes.has('spreadsheet') && /\.(xlsx|xls|csv|tsv)\b/.test(normalizedQuery)) score += 8;
  if (outputTypes.has('presentation') && /\.(pptx|ppt)\b/.test(normalizedQuery)) score += 8;
  if (outputTypes.has('document') && /\.(docx|doc)\b/.test(normalizedQuery)) score += 8;
  return score;
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

function buildSuggestedToolCall(
  capability: CapabilityRecord,
  query: string,
  missingInputs: CapabilityInputField[],
  nextAction: TaskResolveResult['nextAction'],
): TaskResolveToolCallSuggestion | undefined {
  if (nextAction !== 'execute_capability') return undefined;
  if (missingInputs.length > 0) return undefined;
  const codingSuggestion = buildCodingSuggestedToolCall(capability.id, query);
  if (codingSuggestion) return codingSuggestion;

  const toolName = capabilityToolName(capability);
  if (!toolName) return undefined;

  const notes: string[] = [];
  const parameters = suggestParametersForCapability(capability.id, query, notes);
  if (Object.keys(parameters).length === 0) return {
    toolName,
    parameters,
    confidence: 0.45,
    notes: [`Use ${toolName} as the first tool if it is visible. Fill parameters from the user message and current workspace context.`],
  };

  return {
    toolName,
    parameters,
    confidence: notes.length > 0 ? 0.62 : 0.78,
    notes,
  };
}

function capabilityToolName(capability: CapabilityRecord): string {
  return [
    ...(capability.requiredTools || []),
    ...(capability.tools || []),
  ].find(Boolean) || '';
}

function buildCodingSuggestedToolCall(
  capabilityId: string,
  query: string,
): TaskResolveToolCallSuggestion | undefined {
  if (capabilityId === 'code.review') {
    return {
      toolName: 'Bash',
      parameters: {
        command: 'git status --short && git diff --stat && git diff --name-only',
        description: 'Inspect changed files',
      },
      confidence: 0.72,
      notes: [
        'Use the current IDE/editor context alongside git diff; prioritize changed files and selected code.',
        'Return findings first, with file and line references when possible.',
      ],
    };
  }

  if (capabilityId !== 'code.implement') return undefined;

  const filePath = inferCodeFilePath(query);
  if (filePath) {
    return {
      toolName: 'Read',
      parameters: { file_path: filePath },
      confidence: 0.78,
      notes: [
        'Use the current IDE/editor context first; if the active file or selection matches the request, inspect that target before broad search.',
        'After editing, run focused tests or the relevant build command.',
      ],
    };
  }

  const searchPattern = inferCodeSearchPattern(query);
  if (searchPattern) {
    return {
      toolName: 'Grep',
      parameters: {
        pattern: searchPattern,
        output_mode: 'files_with_matches',
        head_limit: 50,
      },
      confidence: 0.66,
      notes: [
        'Use the current IDE/editor context first; search the workspace only when the active file or selection is not enough.',
        'Prefer Read/Grep/Glob/Edit for code work and Bash for tests, builds, or git inspection.',
      ],
    };
  }

  return {
    toolName: 'Glob',
    parameters: { pattern: CODE_GLOB_PATTERN },
    confidence: 0.55,
    notes: [
      'Start from the current IDE/editor context when available; if the request says this, here, or current file, treat the active file/selection as the target.',
      'If no active file is relevant, inspect likely code entry points before editing and run focused tests afterward.',
    ],
  };
}

function suggestParametersForCapability(
  _capabilityId: string,
  _query: string,
  _notes: string[],
): Record<string, unknown> {
  return {};
}

function inferFilePath(query: string, extensions: string[]): string | undefined {
  const quoted = Array.from(query.matchAll(/["“']([^"”']+)["”']/g))
    .map((match) => match[1])
    .find((value) => extensions.some((extension) => value.toLowerCase().endsWith(extension)));
  if (quoted) return quoted;

  const extensionPattern = [...extensions]
    .sort((a, b) => b.length - a.length)
    .map((extension) => extension.replace('.', '\\.'))
    .join('|');
  const pattern = new RegExp(`([A-Za-z]:[^\\s"'“”]+(?:${extensionPattern})|(?:\\.{1,2}[\\\\/])?[^\\s"'“”，。]+(?:${extensionPattern}))`, 'i');
  return query.match(pattern)?.[1];
}

function inferCodeFilePath(query: string): string | undefined {
  return inferFilePath(query, CODE_FILE_EXTENSIONS);
}

function inferCodeSearchPattern(query: string): string | undefined {
  const quoted = Array.from(query.matchAll(/[`"“']([^`"”']{2,160})[`"”']/g))
    .map((match) => match[1].trim())
    .find((value) => value && !inferCodeFilePath(value));
  if (quoted) return escapeRegExp(quoted);

  const errorMessage = query.match(/(?:error|exception|报错|异常|错误)[:：]\s*([^\n。]{2,160})/i)?.[1]?.trim();
  if (errorMessage) return escapeRegExp(errorMessage);

  const namedSymbol = query.match(/(?:function|class|method|component|symbol|identifier|函数|方法|类|组件|变量|标识符)\s*[:：]?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/i)?.[1];
  if (namedSymbol) return escapeRegExp(namedSymbol);

  const dottedSymbol = query.match(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/)?.[0];
  return dottedSymbol ? escapeRegExp(dottedSymbol) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareCandidates(a: TaskResolveCandidate, b: TaskResolveCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const availabilityRank = (candidate: TaskResolveCandidate) => candidate.capability.status === 'available' ? 0 : 1;
  const availability = availabilityRank(a) - availabilityRank(b);
  if (availability !== 0) return availability;
  return (b.capability.priority || 0) - (a.capability.priority || 0);
}

function emptyResult(query: string, reason: string, locale?: string): TaskResolveResult {
  return {
    intent: 'unknown',
    query,
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

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPrimaryFreeformInput(name: string): boolean {
  return ['topic', 'title', 'subject', 'content', 'query', 'text', 'prompt', 'description'].includes(name);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
