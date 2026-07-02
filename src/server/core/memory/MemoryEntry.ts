// MemoryEntry.ts — Memory types, enums, and interfaces
// Defines the data structures for the memory system

import * as path from 'path';

/** Sanitize an ID to prevent path traversal — returns basename of normalized path */
function sanitizeId(id: string): string {
  return path.basename(path.normalize(id));
}

export enum MemoryScope {
  /** Team memory — shared across all agents */
  Team = 'team',
  /** Agent memory — private to a single agent */
  Agent = 'agent',
  /** Session memory — scoped to a specific conversation session */
  Session = 'session',
}

export enum MemoryType {
  /** User preferences, role info, knowledge level */
  User = 'user',
  /** User feedback, corrections, guidance */
  Feedback = 'feedback',
  /** Project status, decisions, milestones */
  Project = 'project',
  /** Pointers to external systems, docs, references */
  Reference = 'reference',
}

export enum MemoryCategory {
  Episodic = 'episodic',
  Semantic = 'semantic',
  Procedural = 'procedural',
  UserProfile = 'user_profile',
}

/** Map legacy MemoryType to new MemoryCategory. */
export function defaultCategory(type: MemoryType): MemoryCategory {
  switch (type) {
    case MemoryType.User: return MemoryCategory.UserProfile;
    case MemoryType.Feedback: return MemoryCategory.Episodic;
    case MemoryType.Project: return MemoryCategory.Semantic;
    case MemoryType.Reference: return MemoryCategory.Procedural;
    default: return MemoryCategory.Semantic;
  }
}

export interface MemoryEntry {
  /** Short identifier used as filename (without .md) */
  name: string;
  /** Category of the memory */
  type: MemoryType;
  /** One-line summary for index display */
  description: string;
  /** Full Markdown body of the memory */
  content: string;
  /** Which scope this memory belongs to */
  scope: MemoryScope;
  /** Session ID (only for Session-scoped memories) */
  sessionId?: string;
  /** Sub-scope for session memories: 'team' or 'personal' */
  subScope?: 'team' | 'personal';
  /** File modification timestamp (populated when reading files from disk) */
  updatedAt?: number;
  /** Memory category (v2 classification) */
  category?: MemoryCategory;
}

/**
 * Metadata stored in YAML frontmatter of each .md memory file.
 */
export interface MemoryFileMetadata {
  name: string;
  description: string;
  metadata: {
    type: MemoryType;
    scope: MemoryScope;
  };
}

/**
 * Map a tool parameter scope string to a MemoryScope enum value.
 * Handles all scope strings: personal, team, project, session_personal, session_team.
 */
export function mapScope(s: string): MemoryScope {
  switch (s) {
    case 'personal': return MemoryScope.Agent;
    case 'team':
    case 'project': return MemoryScope.Team;
    case 'session_personal':
    case 'session_team': return MemoryScope.Session;
    default: return MemoryScope.Team;
  }
}

/**
 * Map a tool parameter type string to a MemoryType enum value.
 */
export function mapType(t: string): MemoryType {
  switch (t) {
    case 'user': return MemoryType.User;
    case 'feedback': return MemoryType.Feedback;
    case 'project': return MemoryType.Project;
    case 'reference': return MemoryType.Reference;
    default: return MemoryType.Reference;
  }
}

/**
 * Parse the scope from a tool parameter string.
 * Accepts: 'team', 'personal', 'project', 'agent:<id>', 'session:team:<id>', 'session:<id>'
 *
 * For session scopes, the returned object includes an extra `sessionId` field.
 * - 'session:team:<sessionId>' → scope=Session, sessionId set
 * - 'session:<sessionId>'       → scope=Session, sessionId set
 */
export function parseScopeParameter(
  raw: string,
  agentId: string,
): { scope: MemoryScope; agentId: string; sessionId?: string; subScope?: 'team' | 'personal' } {
  const safeAgentId = sanitizeId(agentId);
  // Session-scoped formats: 'session:team:<id>', 'session:personal:<id>', 'session:<id>'
  if (raw.startsWith('session:')) {
    const remainder = raw.slice('session:'.length); // e.g. 'team:abc123', 'personal:abc123', or 'abc123'
    let sessionId: string;
    let subScope: 'team' | 'personal' = 'personal';
    if (remainder.startsWith('team:')) {
      sessionId = sanitizeId(remainder.slice('team:'.length));
      subScope = 'team';
    } else if (remainder.startsWith('personal:')) {
      sessionId = sanitizeId(remainder.slice('personal:'.length));
      subScope = 'personal';
    } else {
      sessionId = sanitizeId(remainder);
    }
    // R7: Validate extracted sessionId is non-empty
    if (!sessionId || !sessionId.trim()) {
      // Fall back to personal scope when sessionId is missing
      return { scope: MemoryScope.Agent, agentId: safeAgentId };
    }
    return { scope: MemoryScope.Session, agentId: safeAgentId, sessionId, subScope };
  }

  switch (raw) {
    case 'team':
    case 'project':
      return { scope: MemoryScope.Team, agentId: 'team' };
    case 'personal':
    case 'agent':
      return { scope: MemoryScope.Agent, agentId: safeAgentId };
    default:
      // B5: Parse agent:<id> format
      if (raw.startsWith('agent:')) {
        const targetAgentId = sanitizeId(raw.slice('agent:'.length).trim());
        if (targetAgentId) {
          return { scope: MemoryScope.Agent, agentId: targetAgentId };
        }
      }
      // Unknown scope defaults to personal
      return { scope: MemoryScope.Agent, agentId: safeAgentId };
  }
}
