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

describe('WorkspaceTabGroup read-only safety', () => {
  it('does not expose legacy edit, save, or external-revert operations', () => {
    const prototype = WorkspaceTabGroup.prototype as any;

    expect(prototype.saveFile).toBeUndefined();
    expect(prototype.saveActiveFile).toBeUndefined();
    expect(prototype._triggerInlineCompletion).toBeUndefined();
    expect(prototype._organizeImports).toBeUndefined();
    expect(prototype._revertExternalChange).toBeUndefined();
  });

  it('registers only read-only Agent and navigation actions on the owning viewer', () => {
    const addEditorAction = vi.fn();
    vi.stubGlobal('window', {
      monaco: {
        editor: { addEditorAction },
        KeyCode: { F12: 2 },
      },
    });
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._agentActionsRegistered = false;
    group._agentActionDisposables = [];
    group._editor = { addAction: vi.fn(() => ({ dispose: vi.fn() })) };

    group._registerAgentActions();

    expect(group._editor.addAction).toHaveBeenCalledTimes(4);
    expect(group._editor.addAction.mock.calls.map((call: any[]) => call[0].id)).toEqual([
      'anoclaw-ask-agent',
      'anoclaw-explain-code',
      'anoclaw-find-bugs',
      'anoclaw-ls-definition',
    ]);
    expect(addEditorAction).not.toHaveBeenCalled();
  });

  it('registers hover and definition providers without completion providers', () => {
    const registerCompletionItemProvider = vi.fn();
    const registerHoverProvider = vi.fn();
    const registerDefinitionProvider = vi.fn();
    vi.stubGlobal('window', {
      monaco: { languages: { registerCompletionItemProvider, registerHoverProvider, registerDefinitionProvider } },
    });
    const constructor = WorkspaceTabGroup as any;
    const original = constructor._languageFeaturesRegistered;
    constructor._languageFeaturesRegistered = false;
    try {
      const group = Object.create(WorkspaceTabGroup.prototype) as any;
      group._registerLanguageFeatures();

      expect(registerCompletionItemProvider).not.toHaveBeenCalled();
      expect(registerHoverProvider).toHaveBeenCalledTimes(3);
      expect(registerDefinitionProvider).toHaveBeenCalledTimes(3);
    } finally {
      constructor._languageFeaturesRegistered = original;
    }
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
    const body = { innerHTML: '', textContent: '', appendChild: vi.fn(), classList: { add: vi.fn() } };
    const tab = { path: 'report.docx', name: 'report.docx' };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._sessionId = 'session-a';
    group._activePath = tab.path;
    group._renderGeneration = 1;
    group._createPreviewBody = vi.fn(() => body);

    const pending = group._showOffice(tab, 1);
    group._activePath = 'new.ts';
    group._renderGeneration = 2;
    body.innerHTML = 'new tab content';
    response.resolve({ ok: true, json: async () => ({ type: 'text', content: 'old preview' }) });
    await pending;

    expect(body.innerHTML).toBe('new tab content');
    expect(body.appendChild).not.toHaveBeenCalled();
  });

  it('automatically refreshes an immutable viewer after an external update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: 'truncated prefix',
        truncated: true,
        previewBytes: 1_048_576,
        size: 2_000_000,
        encoding: 'UTF-8',
        sha256: 'full-sha',
      }),
    })));
    const model = { getValue: () => 'old content', setValue: vi.fn() };
    const tab: any = { path: 'large.txt', name: 'large.txt', fileType: 'text', model };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._tabs = [tab];
    group._sessionId = 'session-a';
    group._activePath = tab.path;
    group._activate = vi.fn();

    await group.checkForExternalChanges();

    expect(model.setValue).toHaveBeenCalledWith('truncated prefix');
    expect(tab.readOnlyReason).toContain('Read-only preview');
    expect(tab.diskSha256).toBe('full-sha');
    expect(tab.content).toBe('truncated prefix');
    expect(group._activate).toHaveBeenCalledWith(tab);
  });

  it('does not report a stale Monaco selection while a rich preview is active', () => {
    const activeModel = {};
    const staleModel = { getValueInRange: vi.fn(() => 'stale selection') };
    const group = Object.create(WorkspaceTabGroup.prototype) as any;
    group._activePath = 'README.md';
    group._tabs = [{ path: 'README.md', name: 'README.md', fileType: 'markdown', model: activeModel }];
    group._editor = {
      getModel: () => staleModel,
      getPosition: () => ({ lineNumber: 99, column: 4 }),
      getSelection: () => ({ isEmpty: () => false, startLineNumber: 90, endLineNumber: 99 }),
    };

    expect(group.getEditorContext()).toMatchObject({
      activeFile: 'README.md',
      cursorLine: 1,
      cursorColumn: 1,
      selectedText: '',
    });
    expect(staleModel.getValueInRange).not.toHaveBeenCalled();
  });
});
