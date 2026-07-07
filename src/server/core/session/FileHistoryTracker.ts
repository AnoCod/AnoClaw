// FileHistoryTracker — tracks file edits so MessageWithdrawalManager can rewind
// destructive tool effects when a message is withdrawn.
//
// One instance per session. Stores backups before Edit/Write tool execution.

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../logger.js';

// ── Singleton per-session tracker registry ──

const _trackers = new Map<string, FileHistoryTracker>();

/** Get (or create) the FileHistoryTracker for a session. */
export function getFileHistoryTracker(sessionId: string, maxSnapshots?: number): FileHistoryTracker {
  let t = _trackers.get(sessionId);
  if (!t) {
    t = new FileHistoryTracker(maxSnapshots);
    _trackers.set(sessionId, t);
  }
  return t;
}

/** Remove the tracker for a session (call on session archive/delete). */
export function clearFileHistoryTracker(sessionId: string): void {
  _trackers.delete(sessionId);
}

interface Snapshot {
  /** Original file content before the edit */
  content: string;
  /** Timestamp of when the snapshot was taken */
  takenAt: number;
  /** Incrementing version number for ordering */
  version: number;
}

interface TrackedFile {
  /** Absolute file path */
  filePath: string;
  /** Ordered snapshots (oldest first) */
  snapshots: Snapshot[];
  /** Monotonic version counter for this file */
  nextVersion: number;
}

export class FileHistoryTracker {
  private _files: Map<string, TrackedFile> = new Map();
  private _maxSnapshots: number;

  constructor(maxSnapshots: number = 50) {
    this._maxSnapshots = maxSnapshots;
  }

  // ── Public API ──

  /**
   * Record the state of a file BEFORE a destructive tool (Edit/Write) executes.
   * Call this BEFORE the tool modifies the file on disk.
   *
   * @returns true if the snapshot was taken, false if the file does not exist
   *         (and therefore no backup is needed — Write will create it).
   */
  async trackEdit(sessionId: string, filePath: string): Promise<boolean> {
    const absPath = path.resolve(filePath);
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      this._makeSnapshot(absPath, content);
      createLogger('anochat.system').debug('File snapshot taken', {
        sid: sessionId,
        file: absPath,
        version: this._files.get(absPath)!.nextVersion - 1,
      });
      return true;
    } catch {
      // File doesn't exist yet — Write will create it. No backup needed.
      return false;
    }
  }

  /**
   * Restore all tracked files to their most recent snapshot state.
   * Called by MessageWithdrawalManager when a destructive tool call is withdrawn.
   */
  async rewindTo(sessionId: string, beforeVersion: number): Promise<string[]> {
    const rewound: string[] = [];
    for (const [filePath, tracked] of this._files) {
      // Find the newest snapshot whose version <= beforeVersion
      const snap = this._findSnapshotAt(tracked, beforeVersion);
      if (!snap) {
        // No snapshot at or before this version — nothing to rewind to.
        // This means the file was created (not edited) after beforeVersion.
        // Delete the file if it exists.
        try {
          await fs.unlink(filePath);
          rewound.push(filePath);
          createLogger('anochat.system').debug('File deleted (no prior snapshot)', {
            sid: sessionId,
            file: filePath,
          });
        } catch {
          // File may not exist — fine
        }
        continue;
      }
      // Restore to snapshot content
      await fs.writeFile(filePath, snap.content, 'utf-8');
      rewound.push(filePath);
      createLogger('anochat.system').debug('File rewound to snapshot', {
        sid: sessionId,
        file: filePath,
        version: snap.version,
      });
    }
    return rewound;
  }

  /** Whether any files have been tracked (any edits occurred). */
  hasAnyChanges(): boolean {
    return this._files.size > 0;
  }

  /** List absolute paths of all tracked files. */
  getTrackedFiles(): string[] {
    return [...this._files.keys()];
  }

  /** Clear all tracked data for this session. */
  clearSession(): void {
    this._files.clear();
  }

  // ── Internal ──

  /**
   * Find the newest snapshot whose version <= targetVersion.
   * Returns undefined if no such snapshot exists (file was created later).
   */
  private _findSnapshotAt(
    tracked: TrackedFile,
    targetVersion: number,
  ): Snapshot | undefined {
    // Snapshots are ordered oldest-first. Walk from newest to oldest.
    for (let i = tracked.snapshots.length - 1; i >= 0; i--) {
      if (tracked.snapshots[i].version <= targetVersion) {
        return tracked.snapshots[i];
      }
    }
    return undefined;
  }

  private _makeSnapshot(filePath: string, content: string): void {
    let tracked = this._files.get(filePath);
    if (!tracked) {
      tracked = { filePath, snapshots: [], nextVersion: 0 };
      this._files.set(filePath, tracked);
    }

    const snapshot: Snapshot = {
      content,
      takenAt: Date.now(),
      version: tracked.nextVersion++,
    };

    tracked.snapshots.push(snapshot);

    // Prune old snapshots if over limit
    while (tracked.snapshots.length > this._maxSnapshots) {
      tracked.snapshots.shift();
    }
  }
}
