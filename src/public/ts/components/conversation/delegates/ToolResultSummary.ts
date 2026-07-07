import type { ToolResultData } from '../types.js';

/**
 * Generates a human-readable one-line summary for a tool result.
 * Each tool type gets a specialized summarizer.
 */
export function generateToolResultSummary(event: ToolResultData): string {
  const content = event.content || '';
  const toolName = event.toolName;

  if (event.isError) {
    const firstLine = content.split('\n')[0].slice(0, 120);
    return firstLine || 'Error';
  }

  switch (toolName) {
    case 'Browser': {
      if (content.includes('[Browser Screenshot]')) return 'Screenshot captured';
      const lines = content.trim().split('\n');
      return lines[0].substring(0, 80);
    }
    case 'Read': {
      if (content.startsWith('[Image file:')) {
        const sizeMatch = content.match(/Size:\s*(.+)/);
        return sizeMatch ? `Read image (${sizeMatch[1]})` : 'Read image';
      }
      if (content.startsWith('[Binary file:')) {
        const sizeMatch = content.match(/Size:\s*(.+)/);
        return sizeMatch ? `Read binary file (${sizeMatch[1]})` : 'Read binary file';
      }
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.every(l => !l.includes(':') && l.length < 200)) {
        return `Read ${lines.length} entries`;
      }
      return `Read ${content.split('\n').length} lines`;
    }
    case 'Write': {
      const lineCount = content.split('\n').length;
      const pathMatch = content.match(/Successfully wrote \d+ chars to (.+)/);
      if (pathMatch) {
        const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
        return `Wrote ${lineCount} lines to ${fileName}`;
      }
      return `Wrote ${lineCount} lines to file`;
    }
    case 'Edit': {
      if (content.includes('Successfully edited')) {
        const pathMatch = content.match(/Successfully edited (.+?):/);
        const replaced = content.includes('replaced');
        if (pathMatch) {
          const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
          return `Updated ${fileName}` + (replaced ? ' (1 change)' : '');
        }
        return replaced ? 'Updated file (1 change)' : 'Updated file';
      }
      return 'Updated file';
    }
    case 'Grep': {
      const matchCount = (content.match(/\n/g) || []).length + (content.trim() ? 1 : 0);
      const fileSet = new Set<string>();
      for (const line of content.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) fileSet.add(line.slice(0, colonIdx).trim());
      }
      if (matchCount === 0 || content.trim() === '(no matches)') return 'No matches found';
      if (fileSet.size > 0) return `Found ${matchCount} matches across ${fileSet.size} files`;
      return `Found ${matchCount} matches`;
    }
    case 'Glob': {
      const files = content.split('\n').filter(l => l.trim() && !l.startsWith('('));
      if (files.length === 0 || content.trim() === '(no matches)') return 'No matches found';
      return `Found ${files.length} files`;
    }
    case 'Bash': {
      const trimmed = content.trim();
      if (!trimmed || trimmed === '(no output)') return 'No output';
      const hasErrorPattern = /error:|failed:|denied|not found|cannot|ENOENT|EPERM/i;
      if (trimmed.length < 60 && !hasErrorPattern.test(trimmed)) return trimmed;
      return `${trimmed.split('\n').length} lines of output`;
    }
    case 'WebSearch': {
      const resultCount = (content.match(/\[.+\]\(https?:\/\//g) || []).length;
      if (resultCount > 0) return `Found ${resultCount} search results`;
      return 'Search completed';
    }
    case 'WebFetch': {
      if (content.length < 100) return content.slice(0, 80);
      return `Fetched ${content.length} characters`;
    }
    case 'TodoWrite':
      return 'Todo list updated';
    case 'memory_save':
      return 'Memory saved';
    case 'memory_search': {
      const resultCount = content.split('\n').filter(l => l.trim()).length;
      return `Found ${resultCount} memory entries`;
    }
    case 'TaskAssign':
    case 'SubAgentSpawn':
      return 'Task started';
    default: {
      const firstLine = content.split('\n')[0].slice(0, 100);
      return firstLine || 'Completed';
    }
  }
}
