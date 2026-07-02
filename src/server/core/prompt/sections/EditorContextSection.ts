// EditorContextSection — injects workspace editor state into the system prompt
// Priority 83: between UserAwareness (82) and ActiveTask (84)
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SessionManager } from '../../session/index.js';

export const sectionMeta = {
  name: 'editorContext',
  type: 'dynamic' as const,
  priority: 83,
};

export function createEditorContextSection(): SystemPromptSection {
  return {
    name: 'EditorContext',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      const ec = (session?.metadata?.editorContext as Record<string, unknown>) || null;
      if (!ec) return '';

      const lines: string[] = ['# Editor Context'];
      lines.push('The user has the Workspace page open. Below is their current editor state.');

      const openFiles = ec.openFiles as string[] | undefined;
      if (openFiles && openFiles.length > 0) {
        lines.push(`\n## Open Files (${openFiles.length})`);
        for (const f of openFiles.slice(0, 15)) {
          lines.push(` - ${f}`);
        }
        if (openFiles.length > 15) lines.push(` ... and ${openFiles.length - 15} more`);
      }

      const activeFile = ec.activeFile as string | undefined;
      if (activeFile) {
        lines.push(`\n## Active File: ${activeFile}`);
        const cl = ec.cursorLine as number | undefined;
        const cc = ec.cursorColumn as number | undefined;
        if (cl && cc) lines.push(`Cursor: line ${cl}, column ${cc}`);
      }

      const sel = ec.selectedText as string | undefined;
      if (sel && sel.length > 0) {
        const preview = sel.length > 500 ? sel.slice(0, 500) + '...' : sel;
        const sl = ec.selectedStartLine as number | undefined;
        const el = ec.selectedEndLine as number | undefined;
        const range = sl && el ? ` (lines ${sl}-${el})` : '';
        lines.push(`\n## User Selection${range}\n\`\`\`\n${preview}\n\`\`\``);
      }

      lines.push('\n## Instructions');
      lines.push('- When the user asks about code, check Editor Context first — they are likely referring to the active file or selection.');
      lines.push('- If the user says "this" or "here", it means the active file or selection.');
      lines.push('- User selection takes precedence — treat it as the primary target when present.');
      lines.push('- When using Edit/Write tools on workspace files, the active file is the default target.');
      lines.push('');

      return lines.join('\n');
    },
  };
}
