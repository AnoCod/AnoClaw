import { t, type TranslationKey } from '../../../i18n/index.js';
import type { ToolActivityState } from './ToolActivityDelegate.js';

export interface ToolActivityMeta {
  actionKey: TranslationKey;
  result: (state: ToolActivityState) => string | null;
}

const countLines = (content: string): number => content.split('\n').filter(Boolean).length;

/**
 * Localized metadata for known tools. Tool names, paths, commands, and returned
 * content remain verbatim; only frontend-authored verbs, summaries, and units
 * are translated.
 */
export const TOOL_REGISTRY: Record<string, ToolActivityMeta> = {
  Read: {
    actionKey: 'message.tool.action.read',
    result: state => {
      const content = state.result || '';
      if (content.startsWith('[Image')) return t('message.tool.result.imageFile');
      return t('message.tool.result.lines', { count: content.split('\n').length });
    },
  },
  Write: {
    actionKey: 'message.tool.action.write',
    result: state => {
      const match = (state.result || '').match(/Successfully wrote (\d+) chars to (.+)/);
      const path = match?.[2]?.replace(/\\/g, '/').split('/').pop();
      const summary = t('message.tool.result.wroteChars', { count: match?.[1] || '?' });
      return path ? `${summary} → ${path}` : summary;
    },
  },
  Edit: { actionKey: 'message.tool.action.edit', result: () => null },
  Grep: {
    actionKey: 'message.tool.action.search',
    result: state => {
      const content = state.result || '';
      if (!content || content === '(no matches)') return t('message.tool.result.noMatches');
      return t('message.tool.result.matches', { count: countLines(content) });
    },
  },
  Glob: {
    actionKey: 'message.tool.action.find',
    result: state => {
      const content = state.result || '';
      if (!content || content === '(no matches)') return t('message.tool.result.nothingFound');
      return t('message.tool.result.files', { count: countLines(content) });
    },
  },
  Bash: {
    actionKey: 'message.tool.action.run',
    result: state => {
      const content = (state.result || '').trim();
      if (!content) return t('message.tool.result.done');
      return content.length > 80
        ? t('message.tool.result.lines', { count: content.split('\n').length })
        : content;
    },
  },
  WebSearch: {
    actionKey: 'message.tool.action.search',
    result: state => t('message.tool.result.results', {
      count: ((state.result || '').match(/\[.+\]\(https?:\/\//g) || []).length,
    }),
  },
  WebFetch: {
    actionKey: 'message.tool.action.fetch',
    result: state => t('message.tool.result.readChars', { count: (state.result || '').length }),
  },
  ApiCall: {
    actionKey: 'message.tool.action.call',
    result: state => {
      const content = (state.result || '').trim();
      return content
        ? t('message.tool.result.charsResponse', { count: content.length })
        : t('message.tool.result.done');
    },
  },
  Skill: {
    actionKey: 'message.tool.action.use',
    result: state => (state.result || '').trim().slice(0, 120) || t('message.tool.result.done'),
  },
  SkillList: {
    actionKey: 'message.tool.action.list',
    result: state => {
      const count = countLines(state.result || '');
      return count
        ? t('message.tool.result.skills', { count })
        : t('message.tool.result.done');
    },
  },
  SkillInspect: {
    actionKey: 'message.tool.action.inspect',
    result: state => {
      const content = (state.result || '').trim();
      return content
        ? t('message.tool.result.lines', { count: content.split('\n').length })
        : t('message.tool.result.done');
    },
  },
  Organization: {
    actionKey: 'message.tool.action.manage',
    result: state => state.toolInput?.action
      ? t('message.tool.result.operationComplete', { action: String(state.toolInput.action) })
      : t('message.tool.result.operationCompleteGeneric'),
  },
  Team: {
    actionKey: 'message.tool.action.manage',
    result: state => state.toolInput?.action
      ? t('message.tool.result.operationComplete', { action: String(state.toolInput.action) })
      : t('message.tool.result.operationCompleteGeneric'),
  },
  Task: {
    actionKey: 'message.tool.action.manage',
    result: state => {
      const action = String(state.toolInput?.action || '');
      if (action === 'spawn') return t('message.tool.result.subAgentStarted');
      if (action === 'output') {
        const content = (state.result || '').trim();
        return content
          ? t('message.tool.result.lines', { count: content.split('\n').length })
          : t('message.tool.result.done');
      }
      return action
        ? t('message.tool.result.operationComplete', { action })
        : t('message.tool.result.operationCompleteGeneric');
    },
  },
  JobList: {
    actionKey: 'message.tool.action.list',
    result: () => t('message.tool.result.jobsListed'),
  },
  JobOutput: {
    actionKey: 'message.tool.action.read',
    result: () => t('message.tool.result.jobOutputLoaded'),
  },
  JobStop: {
    actionKey: 'message.tool.action.stop',
    result: () => t('message.tool.result.jobStopped'),
  },
  AgentMessage: {
    actionKey: 'message.tool.action.message',
    result: state => (state.result || '').trim().slice(0, 80) || t('message.tool.result.sent'),
  },
  memory_save: {
    actionKey: 'message.tool.action.save',
    result: () => t('message.tool.result.memorySaved'),
  },
  memory_search: {
    actionKey: 'message.tool.action.search',
    result: state => {
      const count = countLines(state.result || '');
      return count
        ? t('message.tool.result.entries', { count })
        : t('message.tool.result.noneFound');
    },
  },
  memory_delete: {
    actionKey: 'message.tool.action.delete',
    result: () => t('message.tool.result.memoryDeleted'),
  },
  NotebookEdit: {
    actionKey: 'message.tool.action.edit',
    result: () => t('message.tool.result.cellEdited'),
  },
  RestartServer: {
    actionKey: 'message.tool.action.restart',
    result: () => t('message.tool.result.serverRestarted'),
  },
  Sleep: {
    actionKey: 'message.tool.action.wait',
    result: state => {
      const duration = state.toolInput?.seconds || state.toolInput?.duration;
      return duration ? `${duration}s` : t('message.tool.result.done');
    },
  },
  TodoWrite: {
    actionKey: 'message.tool.action.update',
    result: () => t('message.tool.result.todoUpdated'),
  },
};
