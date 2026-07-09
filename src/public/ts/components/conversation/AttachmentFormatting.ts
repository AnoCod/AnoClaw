import type { Attachment } from './types.js';

export function attachmentDisplayLabel(attachments: Attachment[]): string {
  const names = attachments.map(a => a.name || 'unnamed').join(', ');
  return `[Attached: ${names || 'file'}]`;
}

export function attachmentPromptBlocks(attachments: Attachment[]): string[] {
  return attachments.map((attachment) => {
    const name = attachment.name || 'unnamed';
    if (typeof attachment.content === 'string') {
      return `[File: ${name}]\n${attachment.content || '(empty file)'}`;
    }

    const details = [
      attachment.type ? `type=${attachment.type}` : '',
      Number.isFinite(attachment.size) ? `size=${attachment.size} bytes` : '',
    ].filter(Boolean).join(', ');
    return `[Attached file: ${name}]\nContent not available in message payload.${details ? ` Metadata: ${details}.` : ''}`;
  });
}

export function buildPromptContentWithAttachments(content: string, attachments: Attachment[]): string {
  const blocks = attachmentPromptBlocks(attachments);
  if (blocks.length === 0) return content;
  const prefix = blocks.join('\n\n');
  if (!content) return prefix;
  if (content.includes(prefix)) return content;
  return `${prefix}\n\n${content}`;
}
