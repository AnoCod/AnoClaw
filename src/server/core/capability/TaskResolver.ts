import type {
  CapabilityInputField,
  CapabilityRecord,
  TaskResolveCandidate,
  TaskResolveRequest,
  TaskResolveResult,
  TaskResolveToolCallSuggestion,
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
    const suggestedToolCall = buildSuggestedToolCall(capability, query, missingInputs, nextAction);

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
      suggestedToolCall,
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

  const fileTypeBoost = explicitFileTypeBoost(capability, normalizedQuery);
  if (fileTypeBoost > 0) score += fileTypeBoost;

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

function explicitFileTypeBoost(capability: CapabilityRecord, normalizedQuery: string): number {
  const artifactTypes = new Set((capability.artifactTypes || [])
    .map(normalize)
    .filter(Boolean));
  for (const output of capability.outputs || []) {
    if (output.artifactType) artifactTypes.add(normalize(output.artifactType));
    if (output.extension) artifactTypes.add(normalize(output.extension));
  }
  artifactTypes.add(normalize(capability.domain));

  let score = 0;
  for (const type of artifactTypes) {
    if (!type) continue;
    if (normalizedQuery.includes(`.${type}`)) score += 10;
  }
  if (artifactTypes.has('pdf') && /\bpdf\b|\.pdf\b/.test(normalizedQuery)) score += 6;
  if (artifactTypes.has('spreadsheet') && /\.(xlsx|xls|csv|tsv)\b/.test(normalizedQuery)) score += 8;
  if (artifactTypes.has('presentation') && /\.(pptx|ppt)\b/.test(normalizedQuery)) score += 8;
  if (artifactTypes.has('document') && /\.(docx|doc)\b/.test(normalizedQuery)) score += 8;
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
  capabilityId: string,
  query: string,
  notes: string[],
): Record<string, unknown> {
  const title = inferTaskTitle(query);
  switch (capabilityId) {
    case 'presentation.create':
      return compactObject({
        topic: title,
        slideCount: inferSlideCount(query) || 8,
        style: inferStyle(query),
      });
    case 'document.create':
      return compactObject({
        title,
        documentType: inferDocumentType(query),
        style: inferStyle(query),
      });
    case 'spreadsheet.analyze': {
      const filePath = inferFilePath(query, ['.csv', '.tsv', '.xlsx', '.xls']);
      if (!filePath) notes.push('No spreadsheet path was explicit; use an attached/current spreadsheet if available, otherwise ask for the file.');
      return compactObject({
        title,
        filePath,
      });
    }
    case 'pdf.summarize': {
      const filePath = inferFilePath(query, ['.pdf']);
      if (!filePath) notes.push('No PDF path was explicit; use an attached/current PDF if available, otherwise ask for the file.');
      return compactObject({
        title,
        filePath,
        pages: inferPageRange(query),
      });
    }
    case 'files.organize': {
      const folderPath = inferFolderPath(query);
      if (!folderPath) notes.push('No folder path was explicit; use the current workspace folder as the default target.');
      return compactObject({
        folderPath,
        recursive: /recursive|recursively|子文件夹|递归/.test(query.toLowerCase()),
        apply: /apply|execute|move now|直接整理|直接移动|执行整理/.test(query.toLowerCase()),
      });
    }
    case 'web.research': {
      notes.push('Create a cited research artifact with source links; fetch top sources when possible.');
      return compactObject({
        query: inferResearchQuery(query),
        title,
        maxSources: inferSourceCount(query) || 5,
        fetchPages: true,
      });
    }
    default:
      return {};
  }
}

function inferTaskTitle(query: string): string {
  return query
    .replace(/^\s*(帮我|请|麻烦|please)\s*/i, '')
    .replace(/\s*(做一个|做一份|制作|创建|生成|写一份|写一个|总结|分析|整理|create|make|generate|write|summarize|analyze|organize)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || query.trim().slice(0, 120);
}

function inferSlideCount(query: string): number | undefined {
  const arabic = query.match(/(\d{1,2})\s*(页|张|slides?|slide deck)/i)?.[1];
  if (arabic) return clampNumber(Number(arabic), 1, 60, undefined);
  const chineseNumber = query.match(/([一二三四五六七八九十]{1,3})\s*(页|张)/)?.[1];
  return chineseNumber ? chineseNumeralToNumber(chineseNumber) : undefined;
}

function inferStyle(query: string): string | undefined {
  const styles = [
    ['商务', '简洁商务'],
    ['简洁', '简洁'],
    ['正式', '正式'],
    ['专业', '专业'],
    ['可爱', '轻松友好'],
    ['business', 'clean business'],
    ['professional', 'professional'],
    ['concise', 'concise'],
  ];
  const normalized = query.toLowerCase();
  return styles.find(([term]) => normalized.includes(term))?.[1];
}

function inferDocumentType(query: string): string | undefined {
  const normalized = query.toLowerCase();
  if (/合同|contract/.test(normalized)) return 'contract draft';
  if (/报告|report/.test(normalized)) return 'report';
  if (/方案|proposal/.test(normalized)) return 'proposal';
  if (/简历|resume|cv/.test(normalized)) return 'resume';
  if (/申请书|application/.test(normalized)) return 'application';
  return undefined;
}

function inferResearchQuery(query: string): string {
  return query
    .replace(/^\s*(帮我|请|麻烦|please)\s*/i, '')
    .replace(/\s*(查一下|搜索|调研|研究一下|找资料|整理资料|search for|search|research|look up|find sources for)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || query.trim().slice(0, 200);
}

function inferSourceCount(query: string): number | undefined {
  const arabic = query.match(/(\d{1,2})\s*(sources?|results?|links?|websites?|来源|资料|链接|网站)/i)?.[1];
  if (arabic) return clampNumber(Number(arabic), 1, 10, undefined);
  const chineseNumber = query.match(/([一二三四五六七八九十]{1,3})\s*(个)?\s*(来源|资料|链接|网站)/)?.[1];
  return chineseNumber ? clampNumber(chineseNumeralToNumber(chineseNumber) || 0, 1, 10, undefined) : undefined;
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

function inferFolderPath(query: string): string | undefined {
  const quoted = query.match(/["“']([^"”']+)["”']/)?.[1];
  if (quoted && !/\.[A-Za-z0-9]{1,8}$/.test(quoted)) return quoted;
  const windowsPath = query.match(/([A-Za-z]:[^\s"'“”，。]+)/)?.[1];
  if (windowsPath) return windowsPath;
  const relativePath = query.match(/((?:\.{1,2}[\\/])?[^\s"'“”，。]+[\\/][^\s"'“”，。]+)/)?.[1];
  return relativePath;
}

function inferPageRange(query: string): string | undefined {
  return query.match(/(?:pages?|第)\s*(\d+\s*(?:-|到|至)\s*\d+|\d+)/i)?.[1]?.replace(/[到至]/g, '-');
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value: number, min: number, max: number, fallback: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function chineseNumeralToNumber(value: string): number | undefined {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  const tenParts = value.split('十');
  if (tenParts.length === 2) {
    const tens = tenParts[0] ? digits[tenParts[0]] || 0 : 1;
    const ones = tenParts[1] ? digits[tenParts[1]] || 0 : 0;
    return tens * 10 + ones;
  }
  return digits[value];
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
