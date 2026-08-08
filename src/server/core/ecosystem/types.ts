/**
 * Ecosystem Bridge — shared types for importing Codex / Claude Code /
 * OpenClaw / OpenCode / Hermes assets into AnoClaw without copying files.
 */

export type EcosystemKind = 'codex' | 'claude' | 'openclaw' | 'opencode' | 'hermes';

export type EcosystemAssetType = 'skill' | 'mcp' | 'plugin' | 'command' | 'agent' | 'hook' | 'rule';

/**
 * Support level for an imported asset:
 *  - native:      parsed directly into an AnoClaw-native construct
 *  - bridge:      executed through a runtime compatibility bridge
 *  - partial:     mapped where formats overlap; some fields ignored
 *  - unsupported: detected but intentionally not executed in v1
 */
export type SupportLevel = 'native' | 'bridge' | 'partial' | 'unsupported';

export type EntryStatus = 'discovered' | 'enabled' | 'disabled' | 'error';

/** A single asset discovered by an ecosystem adapter. */
export interface EcosystemAsset {
  kind: EcosystemKind;
  assetType: EcosystemAssetType;
  /** Original name inside the source ecosystem. */
  name: string;
  /** Human-friendly display name (fallback: name). */
  displayName: string;
  /** Absolute path to the source file/directory. */
  sourcePath: string;
  supportLevel: SupportLevel;
  detail?: string;
  warnings?: string[];
  /** Adapter-specific normalized payload consumed by importers. */
  payload: Record<string, unknown>;
}

/** Per-entry persisted runtime state. */
export interface EcosystemEntryState {
  enabled: boolean;
  trusted: boolean;
  cleanName: boolean;
  status: EntryStatus;
  lastSyncedAt?: string;
  errorMessage?: string;
  warnings?: string[];
}

export interface EcosystemStateFile {
  version: 1;
  updatedAt: string;
  watchEnabled: boolean;
  entries: Record<string, EcosystemEntryState>;
}

export interface EcosystemEntryView {
  id: string;
  kind: EcosystemKind;
  assetType: EcosystemAssetType;
  name: string;
  displayName: string;
  sourcePath: string;
  supportLevel: SupportLevel;
  detail?: string;
  warnings?: string[];
  status: EntryStatus;
  enabled: boolean;
  trusted: boolean;
  cleanName: boolean;
  lastSyncedAt?: string;
  errorMessage?: string;
}

export interface EcosystemKindOverview {
  kind: EcosystemKind;
  label: string;
  count: number;
  roots: string[];
}

export interface EcosystemOverview {
  kinds: EcosystemKindOverview[];
  entries: EcosystemEntryView[];
  total: number;
  watchEnabled: boolean;
}

/** Contract implemented by every ecosystem adapter. */
export interface EcosystemAdapter {
  readonly kind: EcosystemKind;
  scan(): Promise<EcosystemAsset[]>;
  /** Root paths scanned by this adapter (for the overview UI). */
  roots(): string[];
}

export const ECOSYSTEM_KINDS: EcosystemKind[] = ['codex', 'claude', 'openclaw', 'opencode', 'hermes'];

export const ECOSYSTEM_LABELS: Record<EcosystemKind, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  hermes: 'Hermes',
};

/** Asset types that require an explicit trust review before enablement. */
export function requiresTrustReview(assetType: EcosystemAssetType, supportLevel: SupportLevel): boolean {
  if (assetType === 'plugin') return supportLevel === 'bridge' || supportLevel === 'partial';
  return false;
}
