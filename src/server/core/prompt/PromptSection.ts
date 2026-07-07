// PromptSection — interface for system prompt sections

export interface PromptContext {
  agentId: string;
  sessionId: string;
  /** Per-run permission mode selected by the active AgentLoop. */
  permissionMode?: string;
  /** Per-run effort level selected by the active AgentLoop. */
  effort?: string;
  /** Hide tools that pause for direct user input from prompt/tool listings. */
  hideUserInteractionTools?: boolean;
  /** Tool names granted only for the active run, usually by capability routing. */
  extraAllowedTools?: string[];
}

export interface SystemPromptSection {
  /** Unique section name, used as cache key */
  name: string;
  /** Compute function that returns the section text */
  compute: (ctx: PromptContext) => string;
  /** true = recompute every request for local section caching */
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
