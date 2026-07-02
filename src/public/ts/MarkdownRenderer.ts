/**
 * MarkdownRenderer — unified markdown → safe HTML for chat messages.
 *
 * Supports: headings, bold/italic/strikethrough, inline code, fenced code blocks
 * (syntax-highlighted via highlightCode), images, links, ordered/unordered lists,
 * task lists (- [x]), blockquotes, tables (GFM), horizontal rules.
 *
 * Safe HTML: a whitelist of structural tags (<div>, <details>, <summary>, <span>,
 * <p>, <h1>-<h6>, <ul>, <ol>, <li>, <code>, <pre>, <strong>, <em>, <del>, <br>,
 * <hr>, <img>, <a>, <table>/<thead>/<tbody>/<tr>/<th>/<td>) are allowed through.
 * Dangerous elements (<script>, <iframe>, event handlers, javascript: URLs) are
 * stripped. All other HTML is escaped.
 *
 * Strategy: split text at code block boundaries, process non-code segments
 * through the markdown pipeline, keep code blocks separate. Code blocks and text
 * never mix — highlightCode output goes direct to HTML without any escaping pass.
 */

import { highlightCode } from './components/tabs/FilePreview.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Matches fenced code blocks. Supports Windows \r\n, optional lang.
const CODE_BLOCK_RE = /```(\S*)[ \t]*\r?\n([\s\S]*?)```/g;

// ── Safe HTML tag whitelist ──
// Tags whose inner content we also scan. Self-closing: img, hr, br.
const SAFE_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'code', 'pre', 'strong', 'em', 'del', 'b', 'i', 'u', 's',
  'br', 'hr', 'img', 'a', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary', 'section', 'article', 'header', 'footer', 'nav', 'main',
  'dl', 'dt', 'dd', 'figure', 'figcaption', 'mark', 'small', 'sub', 'sup',
  'abbr', 'time', 'kbd', 'var', 'samp',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);
const BLOCK_TAGS = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'pre', 'blockquote', 'table', 'details', 'section', 'header', 'footer', 'hr', 'br',
]);

/** Strip dangerous attributes (on* handlers, javascript: URLs). */
function safeAttr(name: string, value: string): string {
  const lower = name.toLowerCase().trim();
  if (lower.startsWith('on')) return '';
  if (lower === 'style') {
    // Strip expression() and -moz-binding from inline styles
    const clean = value.replace(/expression\s*\(/gi, '').replace(/-moz-binding/gi, '');
    return ` style="${esc(clean)}"`;
  }
  if ((lower === 'src' || lower === 'href') && /^\s*javascript:/i.test(value)) return '';
  // Allow class, id, title, alt, src, href, target, rel, type, lang, dir, etc.
  if (/^(class|id|title|alt|src|href|target|rel|type|lang|dir|width|height|loading|open|start|reversed|colspan|rowspan|scope|align)$/i.test(lower)) {
    return ` ${lower}="${esc(value)}"`;
  }
  return '';
}

/**
 * Sanitize user-supplied HTML: allow whitelisted tags, strip dangerous attributes.
 * Content inside allowed tags is recursively processed for markdown.
 */
function sanitizeHtml(raw: string): string {
  // Match any HTML tag-like token: <tagname ...> or </tagname>
  return raw.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_full: string, tag: string, attrsStr: string) => {
    const tagLower = tag.toLowerCase();
    const isClosing = _full.startsWith('</');

    if (!SAFE_TAGS.has(tagLower)) {
      // Unknown tag — escape it
      return isClosing ? esc('</' + tag + '>') : esc('<' + tag + attrsStr + '>');
    }

    if (isClosing) {
      return `</${tagLower}>`;
    }

    if (VOID_TAGS.has(tagLower)) {
      // Parse attributes for self-closing tags
      const cleanAttrs = parseAttrs(attrsStr);
      return `<${tagLower}${cleanAttrs}>`;
    }

    // Opening tag — filter attributes
    const cleanAttrs = parseAttrs(attrsStr);
    return `<${tagLower}${cleanAttrs}>`;
  });
}

function parseAttrs(raw: string): string {
  const parts: string[] = [];
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    const value = m[2] || m[3] || m[4] || '';
    const attr = safeAttr(name, value);
    if (attr) parts.push(attr);
  }
  return parts.join('');
}

/** Detect if text contains HTML tags, even partially. */
function hasHtmlTags(text: string): boolean {
  return /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/.test(text);
}

// ── Table rendering ──

function renderTable(lines: string[], startIdx: number): { html: string; endIdx: number } | null {
  // We need at least 2 lines: header + separator
  if (startIdx + 1 >= lines.length) return null;

  const headerLine = lines[startIdx];
  const sepLine = lines[startIdx + 1];
  if (!/^\|.*\|$/.test(headerLine)) return null;
  if (!/^\|[-: |]+\|$/.test(sepLine)) return null;

  // Parse header cells
  const headers = headerLine.split('|').filter(s => s.trim()).map(s => s.trim());
  // Parse alignment from separator
  const aligns: string[] = sepLine.split('|').filter(s => s.trim()).map(s => {
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    return 'left';
  });

  // Collect body rows
  const rows: string[][] = [];
  let i = startIdx + 2;
  while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
    const cells = lines[i].split('|').filter(s => s.trim()).map(s => s.trim());
    rows.push(cells);
    i++;
  }

  // Build HTML
  let html = '<table class="md-table"><thead><tr>';
  for (let hi = 0; hi < headers.length; hi++) {
    html += `<th class="md-th" style="text-align:${aligns[hi] || 'left'}">${headers[hi]}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let ci = 0; ci < headers.length; ci++) {
      html += `<td class="md-td" style="text-align:${aligns[ci] || 'left'}">${row[ci] || ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  return { html, endIdx: i };
}

// ── File path detection ──

/** Convert recognizable file paths in HTML text to clickable spans. */
function linkifyPaths(html: string): string {
  const EXTS = 'ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|py|rs|go|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala|sh|bash|sql|html|css|scss|less|xml|toml|ini|cfg|conf|md|mdx|txt|log|env|svg|png|jpg|jpeg|gif|ico|vue|svelte|dart|ex|exs|proto|prisma|tf|nix|cmake|gradle|properties|lock|gitignore|dockerfile|makefile';
  const pat =
    `(?<![>'"])` +
    `((?:[a-zA-Z]:[\\\\/]|~\\/|\\/[\\w\\-.]+[\\\\/])[^\\s<>"{}|^\`\\[\\]()]+\\.(?:${EXTS})` +
    `|` +
    `\\b[\\w\\-.]+[\\\\/][^\\s<>"{}|^\`\\[\\]()]+\\.(?:${EXTS}))` +
    `(?::\\d+(?:-\\d+)?)?\\b`;
  return html.replace(new RegExp(pat, 'gi'), (match) =>
    `<span class="clickable-path" data-file-path="${esc(match)}">${match}</span>`
  );
}

// ── Main pipeline ──

/**
 * Process markdown text (non-code segments) through the full rendering pipeline.
 * 1. Sanitize any raw HTML that may be present
 * 2. Render inline markdown elements
 * 3. Render block-level elements (tables, lists, headings, blockquotes, etc.)
 */
function processText(text: string): string {
  // If the text contains raw HTML, run our sanitizer first
  let html = hasHtmlTags(text) ? sanitizeHtml(text) : text;

  // Now escape any remaining unprocessed HTML (sanitizer left safe tags intact)
  // Strategy: mark safe tags with placeholders, escape everything else, restore
  const safeTagPlaceholders: string[] = [];
  html = html.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s(?:[a-zA-Z][a-zA-Z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?\s*)*)?\s*\/?>/g, (tag) => {
    // Only protect tags that passed sanitization (they were rebuilt without dangerous bits)
    // Tags that didn't match a SAFE_TAG in sanitizeHtml would have been escaped already.
    // But we also need to protect the sanitized tags from esc().
    if (/^<\/?(div|span|p|h[1-6]|ul|ol|li|code|pre|strong|em|del|b|i|u|s|br|hr|img|a|blockquote|table|thead|tbody|tr|th|td|caption|details|summary|section|header|footer|nav|main|dl|dt|dd|figure|figcaption|mark|small|sub|sup|abbr|time|kbd|var|samp)\b/i.test(tag)) {
      const idx = safeTagPlaceholders.length;
      safeTagPlaceholders.push(tag);
      return `\x01${idx}\x01`;
    }
    return tag;
  });

  // Escape remaining text
  html = esc(html);

  // Restore safe tags
  html = html.replace(/\x01(\d+)\x01/g, (_m, idx) => safeTagPlaceholders[parseInt(idx)] || '');

  // ── Inline markdown (on already-safe HTML) ──
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
    '<span class="md-image-wrapper"><img src="$2" alt="$1" class="md-inline-image" loading="lazy" onerror="this.style.display=\'none\'"></span>');
  // Links — only where NOT inside <a> tags
  html = html.replace(/(?<!href=")(?<!>)(?<!")(?<!')\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" data-external-url="true" rel="noopener noreferrer" class="md-link">$1</a>');
  // Auto-link bare URLs (not already inside href or an <a> tag)
  html = html.replace(/(?<!["'=><])(https?:\/\/[^\s<>"{}|\\^`\[\]]+)(?!<\/a>)/g,
    '<a href="$1" data-external-url="true" rel="noopener noreferrer" class="md-link">$1</a>');
  // Bold+Italic first (longest match)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic — after ** and *** are consumed, remaining single * pairs
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Inline code (don't match inside <code> tags)
  html = html.replace(/(?<!<code[^>]*>)`([^`]+)`(?!<\/code>)/g, '<code class="md-inline-code">$1</code>');

  // File path → clickable span (after inline code, before block processing)
  html = linkifyPaths(html);

  // ── Block-level elements ──
  const lines = html.split('\n');
  const out: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let pendingBlank = false;

  function closeList() { if (inList) { out.push(`</${inList}>`); inList = null; } }
  function closeBq() { if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; } }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Blank line
    if (/^\s*$/.test(line)) { closeList(); closeBq(); pendingBlank = true; continue; }
    // HR
    if (/^-{3,}\s*$/.test(line)) { closeList(); closeBq(); out.push('<hr class="md-hr">'); continue; }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) { closeList(); closeBq(); out.push(`<h${hMatch[1].length} class="md-heading">${hMatch[2]}</h${hMatch[1].length}>`); continue; }

    // Table — need to detect before other patterns
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[-: |]+\|$/.test(lines[i + 1])) {
      closeList(); closeBq();
      const tableResult = renderTable(lines, i);
      if (tableResult) {
        out.push(tableResult.html);
        i = tableResult.endIdx - 1; // -1 because the for loop will ++
        pendingBlank = false;
        continue;
      }
    }

    // Task list
    const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (taskMatch) {
      if (inList !== 'ul') { closeList(); inList = 'ul'; out.push('<ul class="md-ul md-task-list">'); }
      const checked = taskMatch[2].toLowerCase() === 'x';
      const cb = `<span class="md-task-cb">${checked ? '☑' : '☐'}</span>`;
      out.push(`<li class="md-li md-task-li">${cb} ${taskMatch[3]}</li>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) { closeList(); if (!inBlockquote) { inBlockquote = true; out.push('<blockquote class="md-blockquote">'); } out.push(`<p class="md-bq-p">${bqMatch[1] || '&nbsp;'}</p>`); continue; }
    closeBq();

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) { if (inList !== 'ul') { closeList(); inList = 'ul'; out.push('<ul class="md-ul">'); } out.push(`<li class="md-li">${ulMatch[2]}</li>`); continue; }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) { if (inList !== 'ol') { closeList(); inList = 'ol'; out.push('<ol class="md-ol">'); } out.push(`<li class="md-li">${olMatch[2]}</li>`); continue; }

    closeList();

    if (pendingBlank || out.length === 0) {
      out.push('<p class="md-p">');
    } else {
      out.push('<br>');
    }
    out.push(line);
    pendingBlank = false;
  }
  closeList();
  closeBq();
  if (out.length > 0 && out[out.length - 1] !== '</p>' && !out[out.length - 1].startsWith('</')) {
    out.push('</p>');
  }

  return out.join('\n');
}

// ── Exported entry point ──

/**
 * Render markdown to safe HTML.
 * Code blocks are extracted first and never pass through the escaping pipeline.
 */
export function renderMarkdown(text: string): string {
  interface Slot { index: number; html: string }
  const slots: Slot[] = [];
  let match: RegExpExecArray | null;

  CODE_BLOCK_RE.lastIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const lang = match[1];
    const code = match[2].trimEnd();
    // Skip empty code blocks (render as nothing — avoids a ghost rectangle)
    if (!code.trim()) {
      slots.push({ index: match.index, html: '' });
      continue;
    }
    const highlighted = highlightCode(code, lang || '');
    const langLabel = lang ? `<span class="md-code-lang">${esc(lang)}</span>` : '';
    slots.push({
      index: match.index,
      html: `<div class="md-code-block">${langLabel}<pre><code>${highlighted}</code></pre></div>`,
    });
  }

  if (slots.length === 0) return processText(text);

  const parts: string[] = [];
  let cursor = 0;

  CODE_BLOCK_RE.lastIndex = 0;
  let slotIdx = 0;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null && slotIdx < slots.length) {
    const before = text.slice(cursor, match.index);
    parts.push(processText(before));
    parts.push(slots[slotIdx].html);
    cursor = CODE_BLOCK_RE.lastIndex;
    slotIdx++;
  }
  if (cursor < text.length) {
    parts.push(processText(text.slice(cursor)));
  }

  return parts.join('\n');
}
