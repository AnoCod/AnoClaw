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
  userMode?: string;
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

export type TaskResolveIntent = 'capability' | 'chat' | 'unknown';

export type TaskResolveNextAction =
  | 'execute_capability'
  | 'ask_user'
  | 'recommend_plugin'
  | 'chat';

export interface TaskResolveResult {
  intent: TaskResolveIntent;
  query: string;
  confidence: number;
  nextAction: TaskResolveNextAction;
  canStart: boolean;
  bestCapability?: CapabilityRecord;
  candidates: TaskResolveCandidate[];
  missingInputs: CapabilityInputField[];
  missingTools: string[];
  recommendedPlugins: string[];
  assumptions: string[];
  reason: string;
  suggestedResponse: string;
}
