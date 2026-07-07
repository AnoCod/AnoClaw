// PluginDevSection — concise plugin development guide for agents.
// Gives the agent the minimum pattern for a working AnoClaw plugin while the
// full source-aligned references live in docs/plugin-dev.md and docs/plugin-api.md.

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
        'Plugins live in `plugins/<name>/`. A minimal plugin needs `plugin.json` + `extension.js`.',
        'Changes auto-reload within 1-2 seconds. Do not restart unless the runtime requires it.',
        '',
        '## plugin.json template',
        '```json',
        '{',
        '  "name": "my-plugin",',
        '  "displayName": "My Plugin",',
        '  "version": "1.0.0",',
        '  "description": "What this plugin does",',
        '  "main": "extension.js",',
        '  "activationEvents": ["onStartup"],',
        '  "contributes": {',
        '    "tools": [{ "name": "myTool" }],',
        '    "capabilities": [',
        '      {',
        '        "id": "my-plugin.doThing",',
        '        "title": "Do a user-level thing",',
        '        "domain": "utility",',
        '        "kind": "artifact",',
        '        "triggers": ["do thing", "make thing"],',
        '        "requiredTools": ["myTool"],',
        '        "outputs": [{ "type": "artifact", "artifactType": "result" }]',
        '      }',
        '    ]',
        '  }',
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
        '- **PluginBase import**: MUST use `const { PluginBase } = globalThis;` — do not import from filesystem.',
        '- **plugin.json**: Name must be kebab-case, unique. `main` points to entry file.',
        '- **capabilities**: declare user-level tasks in `contributes.capabilities`; tools are implementation details, capabilities are how AnoClaw routes ordinary user requests.',
        '- **tools**: `onToolExecute()` / `executeTool()` must return a string. For structured data use `JSON.stringify()`.',
        '- **hot reload**: Save file, wait 2s, check status. Plugin errors appear as SYSTEM messages in this conversation.',
        '- **check status**: use `ApiCall` with `GET /api/v1/plugins`, or Bash: `curl http://127.0.0.1:3456/api/v1/plugins`.',
        '- **full docs**: Read `docs/plugin-dev.md` before creating plugins and `docs/plugin-api.md` before using API details.',
      ].join('\n');
    },
  };
}
