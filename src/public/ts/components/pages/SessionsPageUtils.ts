/**
 * AnoClaw — SessionsPage Utilities
 * Escape, formatting, and markdown sanitization helpers.
 */

/** Escape HTML entities to prevent XSS. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Basic Markdown-to-HTML for streaming display (bold, italic, code, line breaks, images, links). */
export function sanitizeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Images: ![alt](url)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-inline-image" loading="lazy" style="max-width:100%;border-radius:6px;margin:4px 0;" onerror="this.style.display=\'none\';this.insertAdjacentHTML(\'afterend\',\'[Image: $1]\')">')
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>')
    // Raw URLs → auto-link (avoid double-linking already-tagged ones)
    .replace(/(?<!["'=>])(https?:\/\/[^\s<>"{}|\\^`\[\]]+)(?!<\/a>)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`(.+?)`/g, '<code class="md-inline-code">$1</code>')
    // Line breaks
    .replace(/\n/g, '<br>');
}

/** Format a timestamp (number ms or ISO string) as a human-readable time. */
export function formatTime(ts: string | number): string {
  const d = new Date(typeof ts === 'string' ? ts : ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60000) return 'Just now';
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Format an agent ID into a human-readable name. */
export function formatAgentName(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
