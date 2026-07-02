// DocsSection — points agents to AnoClaw's embedded documentation.
// Uses writablePath so paths resolve correctly in both dev mode (docs/) and
// packaged asar mode (app.asar.unpacked/docs/).
import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { writablePath } from '../../../infra/WritablePath.js';


export const sectionMeta = {
  name: 'docs',
  type: 'static' as const,
  priority: 10,  // First thing after system rules
};
export function createDocsSection(): SystemPromptSection {
  return {
    name: 'Docs',
    cacheBreak: false,
    compute: (_ctx: PromptContext) => {
      const docsDir = writablePath('docs');
      const apiPath = writablePath('docs', 'plugin-api.md');
      const devPath = writablePath('docs', 'plugin-dev.md');
      const designDir = writablePath('docs', 'design-md');

      return [
        '# Embedded Documentation',
        '',
        'AnoClaw comes with built-in developer documentation. Use absolute paths to Read:',
        '',
        `- \`${apiPath}\` — Complete API reference: all 12 \`anoclaw.*\` APIs, 25 UI components, tool cards, slot system`,
        `- \`${devPath}\` — Plugin development guide: quick start, architecture, manifest, lifecycle, troubleshooting`,
        `- \`${designDir}/\` — 75 brand design tokens (Apple, Stripe, Linear, etc.) for building UI components`,
        '',
        '**Rules for using docs:**',
        '- When a user asks about plugins, Read the doc FIRST — don\'t guess from memory.',
        '- When you don\'t know an API detail, Read the doc before answering.',
        '- When building UI, pick a brand from \`docs/design-md/\`, read its DESIGN.md, and follow its tokens exactly.',
        `- Use \`Glob ${docsDir}/**\` to discover new guides added in future updates.`,
        '- The docs are on disk right now — no network needed, no search required.',
      ].join('\n');
    },
  };
}
