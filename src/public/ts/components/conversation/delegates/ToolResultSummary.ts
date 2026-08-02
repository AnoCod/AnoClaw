import { t, type TranslationKey } from '../../../i18n/index.js';
import type { ToolResultData } from '../types.js';

type SummaryParams = Record<string, string | number>;

export interface ToolResultSummaryDescriptor {
  text: string;
  key?: TranslationKey;
  params?: SummaryParams;
}

function localized(key: TranslationKey, params: SummaryParams = {}): ToolResultSummaryDescriptor {
  return { text: t(key, params), key, params };
}

function verbatim(text: string): ToolResultSummaryDescriptor {
  return { text };
}

/**
 * Generates a one-line summary while preserving its translation key. Cards use
 * the descriptor metadata to refresh already-rendered summaries in place.
 * Tool-provided output remains verbatim and is never treated as UI copy.
 */
export function generateToolResultSummaryDescriptor(event: ToolResultData): ToolResultSummaryDescriptor {
  const content = event.content || '';
  const toolName = event.toolName;

  if (event.isError) {
    const firstLine = content.split('\n')[0].slice(0, 120);
    return firstLine ? verbatim(firstLine) : localized('message.tool.error');
  }

  switch (toolName) {
    case 'Browser': {
      if (content.includes('[Browser Screenshot]')) {
        return localized('message.tool.summary.screenshotCaptured');
      }
      return verbatim(content.trim().split('\n')[0].substring(0, 80));
    }
    case 'Read': {
      if (content.startsWith('[Image file:')) {
        const sizeMatch = content.match(/Size:\s*(.+)/);
        return sizeMatch
          ? localized('message.tool.summary.readImageSize', { size: sizeMatch[1] })
          : localized('message.tool.summary.readImage');
      }
      if (content.startsWith('[Binary file:')) {
        const sizeMatch = content.match(/Size:\s*(.+)/);
        return sizeMatch
          ? localized('message.tool.summary.readBinarySize', { size: sizeMatch[1] })
          : localized('message.tool.summary.readBinary');
      }
      const lines = content.split('\n').filter(line => line.trim());
      if (lines.every(line => !line.includes(':') && line.length < 200)) {
        return localized('message.tool.summary.readEntries', { count: lines.length });
      }
      return localized('message.tool.summary.readLines', { count: content.split('\n').length });
    }
    case 'Write': {
      const lineCount = content.split('\n').length;
      const pathMatch = content.match(/Successfully wrote \d+ chars to (.+)/);
      if (pathMatch) {
        const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
        return localized('message.tool.summary.wroteLinesTo', { count: lineCount, file: fileName });
      }
      return localized('message.tool.summary.wroteLinesToFile', { count: lineCount });
    }
    case 'Edit': {
      if (content.includes('Successfully edited')) {
        const pathMatch = content.match(/Successfully edited (.+?):/);
        const replaced = content.includes('replaced');
        if (pathMatch) {
          const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
          return localized(
            replaced
              ? 'message.tool.summary.updatedNamedFileOneChange'
              : 'message.tool.summary.updatedNamedFile',
            { file: fileName },
          );
        }
        return localized(
          replaced
            ? 'message.tool.summary.updatedFileOneChange'
            : 'message.tool.summary.updatedFile',
        );
      }
      return localized('message.tool.summary.updatedFile');
    }
    case 'Grep': {
      const matchCount = (content.match(/\n/g) || []).length + (content.trim() ? 1 : 0);
      const fileSet = new Set<string>();
      for (const line of content.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) fileSet.add(line.slice(0, colonIdx).trim());
      }
      if (matchCount === 0 || content.trim() === '(no matches)') {
        return localized('message.tool.summary.noMatchesFound');
      }
      if (fileSet.size > 0) {
        return localized('message.tool.summary.matchesAcrossFiles', {
          matches: matchCount,
          files: fileSet.size,
        });
      }
      return localized('message.tool.summary.foundMatches', { count: matchCount });
    }
    case 'Glob': {
      const files = content.split('\n').filter(line => line.trim() && !line.startsWith('('));
      if (files.length === 0 || content.trim() === '(no matches)') {
        return localized('message.tool.summary.noMatchesFound');
      }
      return localized('message.tool.summary.foundFiles', { count: files.length });
    }
    case 'Bash': {
      const trimmed = content.trim();
      if (!trimmed || trimmed === '(no output)') {
        return localized('message.tool.summary.noOutput');
      }
      const hasErrorPattern = /error:|failed:|denied|not found|cannot|ENOENT|EPERM/i;
      if (trimmed.length < 60 && !hasErrorPattern.test(trimmed)) return verbatim(trimmed);
      return localized('message.tool.summary.linesOfOutput', {
        count: trimmed.split('\n').length,
      });
    }
    case 'WebSearch': {
      const resultCount = (content.match(/\[.+\]\(https?:\/\//g) || []).length;
      return resultCount > 0
        ? localized('message.tool.summary.foundSearchResults', { count: resultCount })
        : localized('message.tool.summary.searchCompleted');
    }
    case 'WebFetch':
      return content.length < 100
        ? verbatim(content.slice(0, 80))
        : localized('message.tool.summary.fetchedCharacters', { count: content.length });
    case 'TodoWrite':
      return localized('message.tool.summary.todoListUpdated');
    case 'memory_save':
      return localized('message.tool.result.memorySaved');
    case 'memory_search': {
      const resultCount = content.split('\n').filter(line => line.trim()).length;
      return localized('message.tool.summary.foundMemoryEntries', { count: resultCount });
    }
    case 'Task': {
      const action = String(event.toolInput?.action || '');
      if (action === 'spawn' || action === 'assign' || (action === 'create' && event.toolInput?.targetAgentId)) {
        return localized('message.tool.summary.taskStarted');
      }
      if (action === 'list') return localized('message.tool.summary.tasksListed');
      if (action === 'output') return localized('message.tool.summary.taskOutputLoaded');
      return action
        ? localized('message.tool.summary.taskActionCompleted', { action })
        : localized('message.tool.summary.taskCompleted');
    }
    case 'Team': {
      const action = String(event.toolInput?.action || '');
      return action
        ? localized('message.tool.summary.teamActionCompleted', { action })
        : localized('message.tool.summary.teamCompleted');
    }
    case 'Organization': {
      const action = String(event.toolInput?.action || '');
      return action
        ? localized('message.tool.summary.organizationActionCompleted', { action })
        : localized('message.tool.summary.organizationCompleted');
    }
    default: {
      const firstLine = content.split('\n')[0].slice(0, 100);
      return firstLine ? verbatim(firstLine) : localized('message.tool.completed');
    }
  }
}

export function generateToolResultSummary(event: ToolResultData): string {
  return generateToolResultSummaryDescriptor(event).text;
}
