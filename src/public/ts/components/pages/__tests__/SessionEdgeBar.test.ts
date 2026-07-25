import { describe, expect, it } from 'vitest';
import { visibleSessionNodes } from '../SessionEdgeBar.js';
import type { SessionNode } from '../../../types.js';

function node(id: string, children: SessionNode[] = []): SessionNode {
  return { id, title: id, children } as SessionNode;
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
});
