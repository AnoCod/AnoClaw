// PluginDevSection — concise plugin development guide for agents.
// Gives the agent the exact patterns needed to create a working AnoClaw plugin
// without reading the full docs. Short enough to stay in context every turn.

import type { SystemPromptSection, PromptContext } from '../PromptSection.js';

export const sectionMeta = {
  name: 'pluginDev',
  type: 'static' as const,
  priority: 20,  // Right after DocsSection, before Environment
};

export function createPluginDevSection(): SystemPromptSection {
  return {
    name: 'PluginDev',
    cacheBreak: false,
    compute: (_ctx: PromptContext) => {
      return [
        '# Plugin Development Guide',
        '',
        'Plugins live in `plugins/<name>/`. Each plugin needs exactly 2 files: `plugin.json` + `extension.js`.',
        'Changes auto-reload within 1-2 seconds — no restart needed.',
        '',
        '## plugin.json template',
        '```json',
        '{',
        '  "name": "my-plugin",',
        '  "displayName": "My Plugin",',
        '  "version": "1.0.0",',
        '  "main": "extension.js",',
        '  "activationEvents": ["onStartup"]',
        '}',
        '```',
        '',
        '## extension.js — class-based (recommended)',
        '```javascript',
        'const { PluginBase } = globalThis;',
        '',
        'export default class extends PluginBase {',
        '  async onload() {',
        '    await this.registerTool({',
        '      name: "myTool",',
        '      description: "What this tool does — be specific, LLM reads this.",',
        '      parametersSchema: {',
        '        type: "object",',
        '        properties: { input: { type: "string" } },',
        '        required: ["input"],',
        '      },',
        '    });',
        '  }',
        '',
        '  async onToolExecute(name, params) {',
        '    if (name !== "myTool") throw new Error(`Unknown: ${name}`);',
        '    return `Processed: ${params.input}`;',
        '  }',
        '}',
        '```',
        '',
        '## Critical rules',
        '- **PluginBase import**: MUST use `const { PluginBase } = globalThis;` — do NOT import from filesystem.',
        '- **plugin.json**: Name must be kebab-case, unique. `main` points to entry file.',
        '- **tools**: `executeTool()` must return `Promise<string>`. For structured data use `JSON.stringify()`.',
        '- **hot reload**: Save file, wait 2s, check status. Plugin errors appear as SYSTEM messages in this conversation.',
        '- **check status**: `Read /api/v1/plugins` or use Bash: `curl http://127.0.0.1:3456/api/v1/plugins`',
        '- **full API**: Read `docs/plugin-api.md` for complete reference on all 12 `anoclaw.*` APIs.',
      ].join('\n');
    },
  };
}
