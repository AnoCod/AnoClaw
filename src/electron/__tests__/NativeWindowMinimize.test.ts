import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('native window minimize', () => {
  it('uses the normal BrowserWindow minimize path without companion-mode hooks', async () => {
    const [mainSource, preloadSource, titleBarSource] = await Promise.all([
      readFile(new URL('../main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../preload.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../../public/ts/components/TitleBar.ts', import.meta.url), 'utf8'),
    ]);

    expect(mainSource).toContain('win.minimize()');
    expect(preloadSource).toContain("windowMinimize: () => ipcRenderer.send('window-minimize')");
    expect(titleBarSource).toContain('electronAPI?.windowMinimize()');
  });
});
