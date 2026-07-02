// AnoClaw Frontend — Session List Model
// Observable session tree. Maintains a flat list and rebuilds tree on read.

import { EventEmitter } from '../EventEmitter.js';
import type { SessionNode, SessionStatus } from '../types.js';

export class SessionListModel extends EventEmitter {
  private _sessions: SessionNode[] = [];

  /** Returns the tree structure (top-level nodes with nested children) */
  get tree(): SessionNode[] {
    return this._buildTree();
  }

  /** Returns the flat list */
  get all(): ReadonlyArray<SessionNode> {
    return this._sessions;
  }

  addSession(node: SessionNode): void {
    // Ensure it's not already present
    const existingIdx = this._sessions.findIndex((s) => s.id === node.id);
    if (existingIdx !== -1) {
      Object.assign(this._sessions[existingIdx], node);
      this.emit('sessionUpdated', this._sessions[existingIdx]);
    } else {
      this._sessions.push(node);
      this.emit('sessionAdded', node);
      // Ensure children array exists
      if (!node.children) node.children = [];
    }
  }

  removeSession(id: string): void {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const removed = this._sessions[idx];

    // Remove all descendants too
    const toRemove = new Set<string>();
    this._collectDescendants(id, toRemove);
    toRemove.add(id);

    this._sessions = this._sessions.filter((s) => !toRemove.has(s.id));
    this.emit('sessionRemoved', removed);
  }

  updateSession(node: Partial<SessionNode> & { id: string }): void {
    const existing = this._sessions.find((s) => s.id === node.id);
    if (!existing) return;
    // Strip 'children' — it's computed by _buildTree(), not stored
    const { children: _, ...rest } = node as any;
    Object.assign(existing, rest);
    this.emit('sessionUpdated', existing);
  }

  updateStatus(id: string, status: SessionStatus): void {
    const s = this._sessions.find((s) => s.id === id);
    if (!s) return;
    s.status = status;
    this.emit('sessionUpdated', s);
  }

  getById(id: string): SessionNode | undefined {
    return this._sessions.find((s) => s.id === id);
  }

  getChildren(parentId: string): SessionNode[] {
    return this._sessions.filter((s) => s.parentId === parentId);
  }

  getRoots(): SessionNode[] {
    return this._sessions.filter((s) => !s.parentId);
  }

  clear(): void {
    this._sessions = [];
    this.emit('sessionsCleared');
  }

  private _collectDescendants(parentId: string, out: Set<string>): void {
    for (const s of this._sessions) {
      if (s.parentId === parentId) {
        out.add(s.id);
        this._collectDescendants(s.id, out);
      }
    }
  }

  private _buildTree(): SessionNode[] {
    const nodeMap = new Map<string, SessionNode>();
    for (const s of this._sessions) {
      nodeMap.set(s.id, { ...s, children: [] });
    }

    const roots: SessionNode[] = [];
    for (const node of nodeMap.values()) {
      const parentId = node.parentId || (node as any).parentSessionId;
      if (parentId && nodeMap.has(parentId)) {
        nodeMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}
