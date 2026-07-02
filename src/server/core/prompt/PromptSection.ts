// PromptSection — interface for system prompt sections

export interface PromptContext {
  agentId: string;
  sessionId: string;
}

export interface SystemPromptSection {
  /** Unique section name, used as cache key */
  name: string;
  /** Compute function that returns the section text */
  compute: (ctx: PromptContext) => string;
  /** true = recompute every request, breaks prefix caching */
  cacheBreak: boolean;
}

export enum CacheScope {
  /** Shared across all agents and sessions — static zone */
  Global = 'global',
  /** Per-agent — scoped to a specific agentId */
  Agent = 'agent',
  /** Per-session — scoped to a specific sessionId */
  Session = 'session',
}
