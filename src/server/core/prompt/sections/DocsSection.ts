// DocsSection — points agents to AnoClaw's embedded documentation.
// Uses writablePath so paths resolve correctly in both dev mode (docs/) and
// packaged asar mode (app.asar.unpacked/docs/).
import * as fs from 'fs';
import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { writablePath } from '../../../infra/WritablePath.js';

export const sectionMeta = {
  name: 'docs',
  type: 'static' as const,
  priority: 10, // First thing after system rules
};

interface DocsManifestEntry {
  path: string;
  title: string;
  audience?: string[];
  tags?: string[];
  summary?: string;
}

interface DocsManifest {
  version?: number;
  updated?: string;
  entries?: DocsManifestEntry[];
}

function readManifest(manifestPath: string): DocsManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DocsManifest;
  } catch {
    return null;
  }
}

function resolveDocPath(entryPath: string): string {
  const parts = entryPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return writablePath(...parts);
}

function formatManifestEntries(entries: DocsManifestEntry[] | undefined): string[] {
  const relevant = (entries || [])
    .filter(entry => entry.path && entry.title)
    .slice(0, 12);

  return relevant.map(entry => {
    const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : '';
    const summary = entry.summary ? ` — ${entry.summary}` : '';
    return `- \`${resolveDocPath(entry.path)}\` — ${entry.title}${tags}${summary}`;
  });
}

export function createDocsSection(): SystemPromptSection {
  return {
    name: 'Docs',
    cacheBreak: true,
    compute: (_ctx: PromptContext) => {
      const docsDir = writablePath('docs');
      const readmePath = writablePath('docs', 'README.md');
      const manifestPath = writablePath('docs', 'manifest.json');
      const apiPath = writablePath('docs', 'plugin-api.md');
      const devPath = writablePath('docs', 'plugin-dev.md');
      const designDir = writablePath('docs', 'design-md');
      const manifest = readManifest(manifestPath);
      const manifestEntries = formatManifestEntries(manifest?.entries);

      return [
        '# Embedded Knowledge Base',
        '',
        'AnoClaw ships with an agent-readable `docs/` knowledge base. It supplements your abilities but does not replace skills or memory.',
        '',
        '**Core paths:**',
        `- \`${readmePath}\` — human index and routing guide`,
        `- \`${manifestPath}\` — machine-readable docs index`,
        `- \`${apiPath}\` — plugin API reference`,
        `- \`${devPath}\` — plugin development guide`,
        `- \`${designDir}/\` — brand design presets for UI work`,
        ...(manifestEntries.length ? ['', '**Current docs index:**', ...manifestEntries] : []),
        '',
        '**Use docs when:**',
        '- The user asks about AnoClaw features, architecture, plugins, APIs, UI design, troubleshooting, or durable best practices.',
        '- You are creating, modifying, or debugging a plugin.',
        '- You need current product-specific facts instead of general coding knowledge.',
        '',
        '**Retrieval workflow:**',
        `- Start with \`Read ${readmePath}\` or \`Read ${manifestPath}\` for broad routing.`,
        `- Use \`Grep <keyword> ${docsDir}\` to find relevant passages.`,
        `- Use \`Glob ${docsDir}/**\` to discover guides added after this prompt was written.`,
        '- Read the relevant doc before giving confident product/API guidance.',
        '- For UI work, choose a suitable brand in `docs/design-md/`, read its `DESIGN.md`, then adapt it to AnoClaw usability rules.',
        '',
        '**Maintenance rules:**',
        '- If docs conflict with source code or runtime behavior, trust verified source/runtime evidence and update docs.',
        '- Store public, reusable product knowledge in docs; store executable workflows in skills; store user/project preferences in memory.',
        '- Do not put secrets, private user data, one-off task state, or unverified guesses in docs.',
      ].join('\n');
    },
  };
}
