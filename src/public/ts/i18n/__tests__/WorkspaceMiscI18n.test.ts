import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '../index.js';
import {
  DEFAULT_COMMANDS,
  filterCommands,
  getCommand,
  setCommands,
} from '../../components/conversation/SlashCommands.js';
import { formatTime } from '../../components/pages/SessionsPageUtils.js';
import { refreshUserMessageLocale } from '../../components/conversation/delegates/UserMessageDelegate.js';
import { WorkspaceTabGroup } from '../../components/pages/workspace/WorkspaceTabGroup.js';

afterEach(() => {
  setCommands(DEFAULT_COMMANDS);
  setLocale('zh-CN');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace and conversation runtime i18n', () => {
  it('relocalizes built-in slash descriptions even when the API supplied English text', () => {
    setCommands([
      {
        name: 'init',
        displayName: 'Init Project',
        description: 'server description',
        category: 'project',
      },
      {
        name: 'custom',
        displayName: 'Custom',
        description: 'Plugin-owned description',
        category: 'workspace',
      },
    ]);

    setLocale('en-US');
    expect(getCommand('init')?.description).toBe(
      'Generate an anoclaw.md file for the current project workspace',
    );

    setLocale('zh-CN');
    expect(getCommand('init')?.description).toBe('为当前项目工作区生成 anoclaw.md 文件');
    expect(getCommand('custom')?.description).toBe('Plugin-owned description');
    expect(filterCommands('项目').map(command => command.name)).toEqual(['init']);
  });

  it('re-registers Monaco editor actions with labels from the active locale', () => {
    const descriptors: Array<{ id: string; label: string }> = [];
    const disposed: string[] = [];
    vi.stubGlobal('window', {
      monaco: {
        KeyCode: { Backslash: 1, F12: 2, KeyO: 3 },
        KeyMod: { Alt: 4, Shift: 8 },
      },
    });
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._editor = {
      addAction: (descriptor: { id: string; label: string }) => {
        descriptors.push(descriptor);
        return { dispose: () => disposed.push(descriptor.id) };
      },
    };
    group._agentActionsRegistered = false;
    group._agentActionDisposables = [];

    setLocale('en-US');
    group._registerAgentActions();
    expect(descriptors.map(item => item.label)).toEqual([
      'Ask Agent',
      'Agent: Explain This',
      'Agent: Find Bugs',
      'AI: Complete at Cursor',
      'IDE: Go to Definition',
      'IDE: Organize Imports',
    ]);

    setLocale('zh-CN');
    group._refreshAgentActions();
    expect(disposed).toHaveLength(6);
    expect(descriptors.slice(-6).map(item => item.label)).toEqual([
      '询问智能体',
      '智能体：解释此处',
      '智能体：查找缺陷',
      'AI：在光标处补全',
      'IDE：转到定义',
      'IDE：整理导入',
    ]);
  });

  it('uses the app locale for session dates and updates timestamps on existing message cards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
    const oldDate = '2025-01-02T03:04:00Z';

    setLocale('en-US');
    expect(formatTime(oldDate)).toBe(
      new Date(oldDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );
    setLocale('zh-CN');
    expect(formatTime(oldDate)).toBe(
      new Date(oldDate).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    );

    const author = {
      dataset: { userMessageAuthorKey: 'message.you' },
      textContent: 'YOU',
    };
    const timestamp = {
      dataset: { userMessageTimestamp: oldDate },
      textContent: '',
    };
    const root = {
      querySelectorAll: (selector: string) => (
        selector === '[data-user-message-author-key]' ? [author] : [timestamp]
      ),
    } as unknown as ParentNode;

    refreshUserMessageLocale(root);
    expect(author.textContent).toBe('你');
    expect(timestamp.textContent).toBe(
      new Date(oldDate).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('provides translated device, status, path, and image labels', () => {
    setLocale('zh-CN');
    expect(t('workspace.browser.device.desktop')).toBe('桌面');
    expect(t('workspace.browser.device.small')).toBe('小屏');
    expect(t('workspace.editor.ai.ready')).toBe('AI 就绪');
    expect(t('workspace.editor.ls.checking')).toBe('语言服务检查中');
    expect(t('workspace.saveFailedStatus', { status: 500 })).toBe('保存失败（HTTP 500）');
    expect(t('workspace.editor.ls.requestFailed', { status: 503 })).toBe('语言服务请求失败（HTTP 503）');
    expect(t('workspace.editor.ai.suggestFailed', { status: 429 })).toBe('AI 补全请求失败（HTTP 429）');
    expect(t('path.desktopRequired')).toBe('需要桌面应用才能打开文件。');
    expect(t('image.clickToPreview')).toBe('点击预览');
  });
});
