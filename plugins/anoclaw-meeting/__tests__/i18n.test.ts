import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const meetingHtmlUrl = new URL('../frontend/index.html', import.meta.url);

async function source(): Promise<string> {
  return readFile(meetingHtmlUrl, 'utf8');
}

function dictionaries(html: string): Record<'en-US' | 'zh-CN', Record<string, string>> {
  const match = html.match(/const MEETING_I18N = (\{[\s\S]*?\n\});\nlet meetingLocale/);
  if (!match) throw new Error('Meeting locale dictionaries were not found');
  return Function(`"use strict"; return (${match[1]});`)();
}

describe('Meeting frontend i18n', () => {
  it('keeps English and Chinese dictionaries in exact non-empty key parity', async () => {
    const localeTables = dictionaries(await source());
    const englishKeys = Object.keys(localeTables['en-US']).sort();
    const chineseKeys = Object.keys(localeTables['zh-CN']).sort();

    expect(englishKeys).toEqual(chineseKeys);
    expect(englishKeys.length).toBeGreaterThan(100);
    expect(Object.values(localeTables['en-US']).every((value) => value.trim().length > 0)).toBe(true);
    expect(Object.values(localeTables['zh-CN']).every((value) => value.trim().length > 0)).toBe(true);

    const placeholders = (value: string) =>
      Array.from(value.matchAll(/\{(\w+)\}/g), match => match[1]).sort();
    for (const key of englishKeys) {
      expect(placeholders(localeTables['en-US'][key]), key).toEqual(
        placeholders(localeTables['zh-CN'][key]),
      );
    }
  });

  it('handles host locale messages and refreshes text without resetting UI state', async () => {
    const html = await source();
    const localeHandler = html.match(
      /if\(e\.data\?\.type==='anoclaw:locale'\)\{([\s\S]*?)\n  \}\n\}\);/,
    )?.[1] || '';

    expect(localeHandler).toContain("meetingLocale=String(e.data.locale");
    expect(localeHandler).toContain('applyMeetingChrome()');
    expect(localeHandler).toContain('window.app?._render()');
    expect(localeHandler).not.toMatch(/_selectedId\s*=/);
    expect(localeHandler).not.toMatch(/_compareIds\s*=/);
    expect(localeHandler).not.toMatch(/searchInput'\)\.value\s*=/);

    // The modal lives outside #app and uses in-place localization markers, so
    // locale rerenders preserve form values and selected templates/agents.
    expect(html).toContain('overlay.className = \'modal-overlay\'');
    expect(html).toContain('data-i18n-placeholder="topicPlaceholder"');
    expect(html).toContain('data-i18n="create"');
    expect(html).toContain("document.querySelectorAll('[data-i18n]')");
  });

  it('boots from the host locale and localizes roles and round labels', async () => {
    const html = await source();

    expect(html).toContain("let meetingLocale = String(window.__ANOCLAW_LOCALE__ || '')");
    expect(html).toContain('const roleLabel=meetingRole(p.role)');
    expect(html).toContain('${meetingRole(role)}');
    expect(html).toContain("tr('round',{round:r})");
  });

  it('does not place stored meeting values into inline scripts or raw HTML', async () => {
    const html = await source();
    const tableSource = await readFile(new URL('../frontend/src/MeetingTable.ts', import.meta.url), 'utf8');

    expect(html).not.toContain('onclick="app._showMemory');
    expect(html).toContain('data-memory-name="${esc(r.memoryName)}"');
    expect(html).toContain('speakerNames.map(esc).join');
    expect(html.match(/\$\{avatarInitial\(/g)).toBeNull();
    expect(html).toContain("const statusClass = ['idle', 'running', 'completed'].includes(m.status)");
    expect(html).not.toContain('<span class="transcript-round">R${entry.round}</span>');
    expect(html).toContain('<span class="transcript-round">R${esc(entry.round)}</span>');
    expect(html).toContain('data-tpl-rounds="${esc(t.maxRounds)}"');
    expect(tableSource).not.toContain('tooltip.innerHTML');
    expect(tableSource).toContain('nameLabel.textContent = p.name || p.id');
  });
});
