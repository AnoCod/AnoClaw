import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('TitleBar drag region', () => {
  it('keeps the flexible left slot draggable while mounted controls remain interactive', async () => {
    const [source, css] = await Promise.all([
      readFile(new URL('../TitleBar.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../css/layout-cinema.css', import.meta.url), 'utf8'),
    ]);

    const leftSlotStyle = source.match(
      /leftSlot\.style\.cssText = '([^']+)'/,
    )?.[1];

    expect(leftSlotStyle).toContain('flex:1 1 auto');
    expect(leftSlotStyle).toContain('-webkit-app-region:drag');
    expect(leftSlotStyle).not.toContain('-webkit-app-region:no-drag');
    expect(css).toMatch(
      /\.topbar-cinema \[data-slot="titlebar-left"\] > \*\s*\{\s*-webkit-app-region: no-drag;\s*\}/,
    );
  });
});
