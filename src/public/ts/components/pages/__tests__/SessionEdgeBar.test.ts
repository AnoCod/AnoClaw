import { describe, expect, it } from 'vitest';
import {
  activeSessionPath,
  splitSessionChildren,
  summarizeSessionTree,
  visibleSessionNodes,
} from '../SessionEdgeBar.js';
import type { SessionNode } from '../../../types.js';

function node(
  id: string,
  children: SessionNode[] = [],
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    id,
    title: id,
    parentId: null,
    status: 'Idle',
    children,
    ...overrides,
  } as SessionNode;
}

describe('SessionEdgeBar active ancestry', () => {
  it('keeps every ancestor and the active grandchild visible', () => {
    const tree = [
      node('root-a', [node('child-a', [node('grandchild-a')]), node('child-b')]),
      node('root-b', [node('child-c')]),
    ];

    expect(visibleSessionNodes(tree, 'grandchild-a').map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ['root-a', 0],
      ['child-a', 1],
      ['grandchild-a', 2],
      ['child-b', 1],
      ['root-b', 0],
    ]);
  });

  it('shows only root nodes when there is no active session', () => {
    const tree = [node('root', [node('child')])];
    expect(visibleSessionNodes(tree, null).map(({ node: item }) => item.id)).toEqual(['root']);
  });

  it('respects explicit branch expansion independently of the active path', () => {
    const tree = [
      node('root-a', [node('child-a')]),
      node('root-b', [node('child-b')]),
    ];

    expect(visibleSessionNodes(tree, 'child-a', new Set(['root-b'])).map(({ node: item }) => item.id)).toEqual([
      'root-a',
      'root-b',
      'child-b',
    ]);
  });

  it('returns the complete path to a deeply nested active session', () => {
    const tree = [node('root', [node('child', [node('leaf')])])];
    expect(activeSessionPath(tree, 'leaf')).toEqual(['root', 'child', 'leaf']);
  });
});

describe('SessionEdgeBar summaries', () => {
  it('summarizes descendant activity for a root row', () => {
    const root = node('root', [
      node('working', [], { status: 'working' }),
      node('error', [node('nested', [], { status: 'tool_executing' })], { status: 'error' }),
    ]);

    expect(summarizeSessionTree(root)).toEqual({
      descendants: 3,
      working: 2,
      errors: 1,
    });
  });

  it('groups coordination sessions away from ordinary task sessions', () => {
    const task = node('task', [], { title: 'Task: Build UI' });
    const coordination = node('coordination', [], { title: 'Coordination: status update' });

    expect(splitSessionChildren([task, coordination])).toEqual({
      sessions: [task],
      coordination: [coordination],
    });
  });
});
