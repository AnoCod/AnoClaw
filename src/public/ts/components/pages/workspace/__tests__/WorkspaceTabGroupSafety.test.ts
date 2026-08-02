import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTabGroup } from '../WorkspaceTabGroup.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WorkspaceTabGroup async safety', () => {
  it('drops a manual AI completion after the editor switches models', async () => {
    const completion = deferred<string>();
    const modelA = {
      getLineContent: () => 'const value = ',
      getLineCount: () => 1,
      getValueInRange: () => 'const value = ',
      getLanguageId: () => 'typescript',
    };
    const modelB = {};
    const editorA = {
      getModel: () => modelA,
      getPosition: () => ({ lineNumber: 1, column: 15 }),
      executeEdits: vi.fn(),
      focus: vi.fn(),
    };
    const editorB = { getModel: () => modelB };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._editor = editorA;
    group._tabs = [{ path: 'a.ts', model: modelA }];
    group._inlineCompletionRequestId = 0;
    group._setInlineCompletionStatus = vi.fn();
    group._requestInlineCompletion = vi.fn(() => completion.promise);

    const pending = group._triggerInlineCompletion(true);
    group._editor = editorB;
    completion.resolve('42;');
    await pending;

    expect(editorA.executeEdits).not.toHaveBeenCalled();
  });

  it('drops organize-import edits after the editor switches models', async () => {
    const response = deferred<{ edits: Array<{ path: string; range: Record<string, number>; text: string }> }>();
    const modelA = {};
    const modelB = {};
    const editorA = { getModel: () => modelA, executeEdits: vi.fn(), focus: vi.fn() };
    const editorB = { getModel: () => modelB, focus: vi.fn() };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._editor = editorA;
    group._tabs = [{ path: 'a.ts', model: modelA }];
    group._setLanguageStatus = vi.fn();
    group._languageFetch = vi.fn(() => response.promise);
    group._monacoRange = (range: unknown) => range;

    const pending = group._organizeImports();
    group._editor = editorB;
    response.resolve({
      edits: [{
        path: 'a.ts',
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        text: 'import x;\n',
      }],
    });
    await pending;

    expect(editorA.executeEdits).not.toHaveBeenCalled();
    expect(editorB.focus).not.toHaveBeenCalled();
  });

  it('registers one global inline provider and routes by model ownership', async () => {
    const providerDisposable = { dispose: vi.fn() };
    const registerInlineCompletionsProvider = vi.fn((_selector: string, _provider: any) => providerDisposable);
    vi.stubGlobal('window', { monaco: { languages: { registerInlineCompletionsProvider } } });

    const modelA = {};
    const first = Object.create(WorkspaceTabGroup.prototype) as any;
    first._inlineCompletionRegistered = false;
    first._tabs = [{ model: modelA }];
    first._provideInlineCompletion = vi.fn(async () => ({ items: [{ insertText: 'owned' }] }));
    const second = Object.create(WorkspaceTabGroup.prototype) as any;
    second._inlineCompletionRegistered = false;
    second._tabs = [{ model: {} }];
    second._provideInlineCompletion = vi.fn();

    const ctor = WorkspaceTabGroup as any;
    const originalGroups = ctor._groups;
    const originalDisposable = ctor._inlineCompletionDisposable;
    ctor._groups = new Set([first, second]);
    ctor._inlineCompletionDisposable = null;
    try {
      first._registerInlineCompletion();
      second._registerInlineCompletion();

      expect(registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
      const provider = registerInlineCompletionsProvider.mock.calls[0]![1];
      await expect(provider.provideInlineCompletions(modelA, {}, {}, {})).resolves.toEqual({ items: [{ insertText: 'owned' }] });
      expect(first._provideInlineCompletion).toHaveBeenCalledTimes(1);
      expect(second._provideInlineCompletion).not.toHaveBeenCalled();
    } finally {
      providerDisposable.dispose();
      ctor._groups = originalGroups;
      ctor._inlineCompletionDisposable = originalDisposable;
    }
  });

  it('registers editor actions on the owning editor instead of globally', () => {
    const addEditorAction = vi.fn();
    vi.stubGlobal('window', {
      monaco: {
        editor: { addEditorAction },
        KeyCode: { Backslash: 1, F12: 2, KeyO: 3 },
        KeyMod: { Alt: 4, Shift: 8 },
      },
    });
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._agentActionsRegistered = false;
    group._agentActionDisposables = [];
    group._editor = { addAction: vi.fn(() => ({ dispose: vi.fn() })) };

    group._registerAgentActions();

    expect(group._editor.addAction).toHaveBeenCalledTimes(6);
    expect(addEditorAction).not.toHaveBeenCalled();
  });

  it('scrubs sensitive controls from page context before sharing it with an agent', async () => {
    const wvExecJs = vi.fn(async (_viewId: string, _code: string) => ({
      ok: true,
      result: JSON.stringify({ title: 'Page', url: 'https://example.test', headings: [], counts: {} }),
    }));
    const api = {
      wvExecJs,
      wvGetConsole: vi.fn(async () => ({ ok: true, logs: [] })),
      wvCaptureScreenshot: vi.fn(async () => ({ ok: false })),
    };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._api = () => api;
    group._sendToAgent = vi.fn();

    await group._sendPageContextToAgent({
      wvId: 'view-a',
      browserUrl: 'https://example.test',
      browserTitle: 'Page',
      name: 'Page',
    });

    const code = wvExecJs.mock.calls[0]![1];
    expect(code).toContain('if (isSensitiveControl(root)) return null');
    expect(code).toContain('bodyText: safeText(document.body, 4500)');
    expect(code).toContain("text: isSensitiveControl(active) ? '' : safeText(active, 1000)");
    expect(code).not.toContain('active.value');
  });

  it('does not let a stale Office preview overwrite the newly active tab', async () => {
    const response = deferred<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const contentArea = { innerHTML: '', style: { cssText: '' }, appendChild: vi.fn() };
    const tab = { path: 'report.docx', name: 'report.docx' };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._contentArea = contentArea;
    group._sessionId = 'session-a';
    group._activePath = tab.path;
    group._renderGeneration = 1;
    group._destroyContent = vi.fn();

    const pending = group._showOffice(tab, 1);
    group._activePath = 'new.ts';
    group._renderGeneration = 2;
    contentArea.innerHTML = 'new tab content';
    response.resolve({ ok: true, json: async () => ({ type: 'text', content: 'old preview' }) });
    await pending;

    expect(contentArea.innerHTML).toBe('new tab content');
    expect(contentArea.appendChild).not.toHaveBeenCalled();
  });

  it('turns a truncated external update into a read-only preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: 'truncated prefix', truncated: true, size: 200_000, sha256: 'full-sha' }),
    })));
    const model = { getValue: () => 'old content', setValue: vi.fn() };
    const tab: any = { path: 'large.txt', fileType: 'code', isDirty: false, model };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._tabs = [tab];
    group._sessionId = 'session-a';
    group._activePath = tab.path;
    group._updateDirty = vi.fn();
    group._activate = vi.fn();
    group._showDiffBanner = vi.fn();

    await group.checkForExternalChanges();

    expect(model.setValue).toHaveBeenCalledWith('truncated prefix');
    expect(tab.readOnlyReason).toContain('Read-only preview');
    expect(tab.diskSha256).toBe('full-sha');
    expect(group._showDiffBanner).not.toHaveBeenCalled();
  });
});
