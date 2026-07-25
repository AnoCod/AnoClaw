import type { Session, Work } from '../model.js';

export interface SessionTreeNode {
  session: Session;
  children: SessionTreeNode[];
}

/**
 * The editable conversation is an explicit Work relationship. A newer Run
 * Session must never replace the Work's MainAgent Session.
 */
export function findPrimarySession(
  work: Pick<Work, 'primarySessionId'>,
  sessions: Session[],
): Session | undefined {
  return sessions.find((session) => session.id === work.primarySessionId);
}

export function buildSessionTree(
  sessions: Session[],
  primarySessionId: string,
): SessionTreeNode[] {
  const nodes = new Map(
    sessions.map((session) => [
      session.id,
      { session, children: [] as SessionTreeNode[] },
    ]),
  );
  const primary = nodes.get(primarySessionId);
  const roots: SessionTreeNode[] = primary ? [primary] : [];

  for (const node of nodes.values()) {
    if (node === primary) continue;
    const parent = node.session.parentSessionId
      ? nodes.get(node.session.parentSessionId)
      : undefined;
    if (parent && parent !== node && !isDescendant(node, parent, nodes)) {
      parent.children.push(node);
    } else if (primary) {
      primary.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortNodes(roots);
  return roots;
}

function isDescendant(
  possibleAncestor: SessionTreeNode,
  node: SessionTreeNode,
  nodes: Map<string, SessionTreeNode>,
): boolean {
  const visited = new Set<string>();
  let parentId = node.session.parentSessionId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === possibleAncestor.session.id) return true;
    visited.add(parentId);
    parentId = nodes.get(parentId)?.session.parentSessionId;
  }
  return false;
}

function sortNodes(nodes: SessionTreeNode[]): void {
  nodes.sort(
    (a, b) => Date.parse(a.session.createdAt) - Date.parse(b.session.createdAt),
  );
  for (const node of nodes) sortNodes(node.children);
}
