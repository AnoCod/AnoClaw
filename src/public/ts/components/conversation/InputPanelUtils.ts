export function hasSendableComposerContent(content: string, attachmentCount: number): boolean {
  return content.trim().length > 0 || attachmentCount > 0;
}
