// AnoclawMdSection — injects workspace-root anoclaw.md into every turn.
// Once /init has been run and the agent has written anoclaw.md to the
// workspace root, this section reads it and includes it in the system prompt.
// If no anoclaw.md exists, the section is silent (zero tokens).
import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SessionManager } from '../../session/index.js';
import * as fs from 'fs';
import * as path from 'path';

export const sectionMeta = {
  name: 'anoclawmd',
  type: 'dynamic' as const,
  priority: 5,  // Right after system rules (0), before docs (10)
};

export function createAnoclawMdSection(): SystemPromptSection {
  return {
    name: 'AnoclawMd',
    cacheBreak: true,  // Re-read on every turn — user may edit the file
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      if (!session?.workspace) return '';

      const filePath = path.join(session.workspace, 'anoclaw.md');
      if (!fs.existsSync(filePath)) return '';

      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content) return '';

        return [
          '# Project Rules (anoclaw.md)',
          'The following project-specific rules and conventions are defined in the workspace.',
          'Follow them strictly. They override any conflicting general guidance.',
          '',
          content,
          '',
          '---',
          'End of anoclaw.md. Resume following the rules above for all workspace operations.',
        ].join('\n');
      } catch {
        return '';  // Permission error or deleted mid-read — skip silently
      }
    },
  };
}
