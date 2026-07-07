export type CapabilitySource = 'catalog' | 'kernel' | 'plugin';

export type CapabilityAvailability =
  | 'available'
  | 'disabled'
  | 'needs_plugin'
  | 'unavailable'
  | 'error';

export type CapabilityKind =
  | 'artifact'
  | 'analysis'
  | 'automation'
  | 'communication'
  | 'knowledge'
  | 'memory'
  | 'utility';

export type UserMode = 'simple' | 'office' | 'coding' | 'child' | 'professional';

export type CapabilityPluginRecommendationStatus =
  | 'activated'
  | 'installed'
  | 'missing'
  | 'error'
  | 'unknown';

export type CapabilityPluginRecommendationAction =
  | 'none'
  | 'activate'
  | 'install'
  | 'reload'
  | 'inspect';

export type CapabilityPluginRecommendationReason =
  | 'recommended'
  | 'capability_provider'
  | 'missing_tools'
  | 'plugin_not_active'
  | 'plugin_error';

export interface CapabilityPluginRecommendation {
  pluginName: string;
  displayName: string;
  status: CapabilityPluginRecommendationStatus;
  action: CapabilityPluginRecommendationAction;
  reason: CapabilityPluginRecommendationReason;
  source: 'local' | 'marketplace' | 'official' | 'community' | 'unknown';
  installable: boolean;
  missingTools: string[];
  version?: string;
  publisher?: string;
  description?: string;
  installUrl?: string;
  installRoute?: string;
  activateRoute?: string;
  errorMessage?: string;
}

export interface CapabilityInputField {
  name: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean' | 'file' | 'folder' | 'choice' | 'object';
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
  examples?: string[];
  aliases?: string[];
}

export interface CapabilityOutput {
  type: string;
  label?: string;
  mimeType?: string;
  extension?: string;
  artifactType?: string;
}

export interface CapabilityDefinition {
  id: string;
  title: string;
  description?: string;
  domain: string;
  kind?: CapabilityKind;
  triggers: string[];
  examples?: string[];
  inputs?: CapabilityInputField[];
  outputs?: CapabilityOutput[];
  tools?: string[];
  requiredTools?: string[];
  skills?: string[];
  artifactTypes?: string[];
  recommendedPlugins?: string[];
  priority?: number;
}

export interface CapabilityRecord extends CapabilityDefinition {
  source: CapabilitySource;
  sourceName: string;
  status: CapabilityAvailability;
  missingTools: string[];
  pluginName?: string;
  pluginStatus?: string;
}

export interface CapabilityListFilters {
  search?: string;
  domain?: string;
  status?: CapabilityAvailability;
  source?: CapabilitySource;
  limit: number;
}

export interface TaskResolveRequest {
  message: string;
  userMode?: UserMode | string;
  locale?: string;
  includeUnavailable?: boolean;
}

export interface TaskResolveCandidate {
  capability: CapabilityRecord;
  score: number;
  confidence: number;
  matchedTerms: string[];
  missingInputs: CapabilityInputField[];
}

export interface TaskResolveToolCallSuggestion {
  toolName: string;
  parameters: Record<string, unknown>;
  confidence: number;
  notes: string[];
}

export type TaskResolveIntent = 'capability' | 'chat' | 'unknown';

export type TaskResolveNextAction =
  | 'execute_capability'
  | 'ask_user'
  | 'recommend_plugin'
  | 'chat';

export interface TaskResolveResult {
  intent: TaskResolveIntent;
  query: string;
  userMode: UserMode;
  locale?: string;
  confidence: number;
  nextAction: TaskResolveNextAction;
  canStart: boolean;
  bestCapability?: CapabilityRecord;
  candidates: TaskResolveCandidate[];
  missingInputs: CapabilityInputField[];
  missingTools: string[];
  recommendedPlugins: string[];
  pluginRecommendations: CapabilityPluginRecommendation[];
  suggestedToolCall?: TaskResolveToolCallSuggestion;
  assumptions: string[];
  reason: string;
  suggestedResponse: string;
}
