import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('global ultra-minimal button styles', () => {
  it('keeps buttons borderless at rest and uses neutral surfaces for interaction states', async () => {
    const css = await readFile(
      new URL('../../../css/zzz-ultra-minimal-buttons.css', import.meta.url),
      'utf8',
    );

    expect(css).toContain('--button-minimal-hover');
    expect(css).toContain('--button-minimal-active');
    expect(css).toMatch(/border:\s*0\s*!important/);
    expect(css).toMatch(/outline:\s*0\s*!important/);
    expect(css).toMatch(/:focus-visible[\s\S]*background:\s*var\(--button-minimal-hover\)\s*!important/);
    expect(css).toMatch(/\.active,[\s\S]*background:\s*var\(--button-minimal-active\)\s*!important/);
    expect(css).toContain('.page-switcher-item.active::before');
    expect(css).toContain('.ws-tab.active::after');
  });

  it('keeps plugin iframe buttons on the same borderless language', async () => {
    const css = await readFile(
      new URL('../../../css/plugin-comfyui.css', import.meta.url),
      'utf8',
    );

    expect(css).toMatch(/button,[\s\S]*border:\s*0\s*!important/);
    expect(css).toMatch(/button:focus-visible[\s\S]*background:\s*var\(--comfy-charcoal-600\)\s*!important/);
    expect(css).not.toMatch(
      /button\.primary,[\s\S]*?\{[\s\S]*?background:\s*var\(--comfy-blue\)/,
    );
  });

  it('preserves accent swatch colors without a selection ring', async () => {
    const [css, settingsSource] = await Promise.all([
      readFile(new URL('../../../css/zzz-ultra-minimal-buttons.css', import.meta.url), 'utf8'),
      readFile(new URL('../pages/SettingsPage.ts', import.meta.url), 'utf8'),
    ]);

    expect(settingsSource).toContain(
      "swatch.style.setProperty('--appearance-swatch-color', a.value)",
    );
    expect(css).toContain('background: var(--appearance-swatch-color, transparent) !important');
    expect(css).toMatch(/\.appearance-swatch\.active::after[\s\S]*content:\s*none\s*!important/);
  });
});
