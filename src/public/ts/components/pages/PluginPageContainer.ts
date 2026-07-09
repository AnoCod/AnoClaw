// PluginPageContainer.ts — iframe sandbox + postMessage bridge for plugin frontend pages.
// Injects tokens.css + anoclaw-ui.js so plugins can use the shared UI component library.

import type { Page, PluginPageContribution } from '../../types.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { pageRegistry } from '../../PageRegistry.js';

export class PluginPageContainer implements Page {
  readonly name: string;
  readonly container: HTMLElement;
  private _htmlPath: string;
  private _iframe: HTMLIFrameElement | null = null;
  private _loaded = false;
  private _tokensInjected = false;

  constructor(contribution: PluginPageContribution) {
    this.name = contribution.id;
    this.container = document.createElement('div');
    this.container.className = 'plugin-page-container';
    this.container.setAttribute('data-plugin', contribution.pluginName);
    this._htmlPath = contribution.htmlPath;

    window.addEventListener('theme-changed', this._onThemeChanged);
    this._installDialogBridge();
    this._installSessionBridge();
  }

  private _installDialogBridge(): void {
    window.addEventListener('message', async (e: MessageEvent) => {
      if (!e.data || e.data.type !== 'anoclaw:dialog:confirm') return;
      const iframe = this._iframe;
      if (!iframe?.contentWindow || e.source !== iframe.contentWindow) return;
      const result = await ConfirmDialog.show(e.data.message, e.data.title);
      iframe.contentWindow.postMessage({
        type: 'anoclaw:dialog:result',
        id: e.data.id,
        result,
      }, '*');
    });
  }

  private _installSessionBridge(): void {
    window.addEventListener('message', async (e: MessageEvent) => {
      if (!e.data || e.data.type !== 'anoclaw:session:handoff') return;
      const iframe = this._iframe;
      if (!iframe?.contentWindow || e.source !== iframe.contentWindow) return;

      const sessionId = String(e.data.sessionId || '');
      const prompt = String(e.data.prompt || '');
      if (!sessionId || !prompt) {
        iframe.contentWindow.postMessage({
          type: 'anoclaw:session:handoff-result',
          id: e.data.id,
          ok: false,
          error: 'sessionId and prompt are required',
        }, '*');
        return;
      }

      try {
        const { App } = await import('../../app.js');
        const app = App.getInstance();
        app.sessionVM.selectSession(sessionId);
        app.conversationVM.setActiveSession(sessionId);
        pageRegistry.navigateTo('sessions');
        const sessionsPage = pageRegistry.getPage('sessions') as { injectInput?: (text: string) => void } | undefined;
        sessionsPage?.injectInput?.(prompt);
        iframe.contentWindow.postMessage({
          type: 'anoclaw:session:handoff-result',
          id: e.data.id,
          ok: true,
          sessionId,
        }, '*');
      } catch (err) {
        iframe.contentWindow.postMessage({
          type: 'anoclaw:session:handoff-result',
          id: e.data.id,
          ok: false,
          error: (err as Error).message,
        }, '*');
      }
    });
  }

  private _onThemeChanged = (): void => {
    this._syncTheme();
  };

  onEnter(): void {
    if (!this._htmlPath) return;
    if (!this._loaded) {
      this._createIframe();
      this._loaded = true;
    }
    if (this._iframe) {
      this._iframe.style.display = '';
      this._syncTheme();
    }
  }

  private _syncTheme(): void {
    if (!this._iframe?.contentWindow) return;
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme') || 'dark';
    const accent = root.getAttribute('data-accent') || 'white';
    this._iframe.contentWindow.postMessage({
      type: 'anoclaw:theme',
      theme,
      accent,
    }, '*');
    // Also update data attributes on iframe's html element for CSS selectors
    this._updateIframeThemeAttrs();
  }

  onExit(): void {
    if (this._iframe) this._iframe.style.display = 'none';
  }

  private _createIframe(): void {
    if (!this._htmlPath) return;
    this._iframe = document.createElement('iframe');
    this._iframe.className = 'plugin-iframe';
    this._iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    console.log(`[Plugin] iframe created: ${this._htmlPath}`);

    // Fetch the plugin HTML and embed it via srcdoc so we can inject
    // anoclaw-ui.js BEFORE the plugin's bundle.js runs.
    const mainBase = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);
    // Resolve plugin directory for relative script/link paths
    const pluginDir = this._htmlPath.substring(0, this._htmlPath.lastIndexOf('/') + 1);

    fetch(this._htmlPath)
      .then(resp => resp.text())
      .then(html => {
        if (!this._iframe) return;
        // Make script src and link href absolute so they resolve correctly in srcdoc
        let fixed = html.replace(
          /(<(?:script[^>]*src|link[^>]*href)=\")([^\"]*)(\"[^>]*>)/gi,
          (_m: string, pre: string, url: string, post: string) => {
            if (url.startsWith('http') || url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:')) return _m;
            return pre + pluginDir + url + post;
          }
        );
        // Inject shared plugin chrome before the plugin bundle runs.
        const pluginBoot = `<script>window.__ANOCLAW_PLUGIN_NAME__=${JSON.stringify(this.container.getAttribute('data-plugin') || '')};</script>`;
        const uiTag = [
          pluginBoot,
          `<link rel=\"stylesheet\" href=\"${mainBase}css/tokens.css\">`,
          `<link rel=\"stylesheet\" href=\"${mainBase}css/plugin-comfyui.css\">`,
          `<script src=\"${mainBase}anoclaw-ui.js\"></script>`,
          `<script src=\"${mainBase}plugin-comfyui.js\"></script>`,
        ].join('');
        if (fixed.includes('</head>')) {
          fixed = fixed.replace('</head>', uiTag + '</head>');
        } else if (fixed.includes('<body>')) {
          fixed = fixed.replace('<body>', '<body>' + uiTag);
        } else {
          fixed = uiTag + fixed;
        }
        this._iframe.srcdoc = fixed;
        console.log(`[Plugin] srcdoc set with assets injected`);
        this._tokensInjected = true;
      })
      .catch(err => {
        console.error(`[Plugin] Failed to fetch plugin HTML: ${err.message}`);
        if (this._iframe) {
          this._iframe.src = this._htmlPath;
          this._iframe.addEventListener('load', () => {
            this._injectAssets();
            this._syncTheme();
          }, { once: true });
        }
      });

    this._iframe.addEventListener('load', () => {
      console.log(`[Plugin] iframe ready: ${this._htmlPath}`);
      this._syncTheme();
    });

    this.container.appendChild(this._iframe);
  }

  private _injectAssets(): void {
    if (this._tokensInjected) return;
    if (!this._iframe?.contentDocument) return;
    const doc = this._iframe.contentDocument;
    const head = doc.head || doc.documentElement;

    // Build paths relative to the main page (not the iframe's base URL)
    const mainBase = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);

    const pluginBoot = doc.createElement('script');
    pluginBoot.textContent = `window.__ANOCLAW_PLUGIN_NAME__=${JSON.stringify(this.container.getAttribute('data-plugin') || '')};`;
    head.appendChild(pluginBoot);

    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = mainBase + 'css/tokens.css';
    head.appendChild(link);

    const pluginSkinLink = doc.createElement('link');
    pluginSkinLink.rel = 'stylesheet';
    pluginSkinLink.href = mainBase + 'css/plugin-comfyui.css';
    head.appendChild(pluginSkinLink);

    this._updateIframeThemeAttrs();

    const script = doc.createElement('script');
    script.src = mainBase + 'anoclaw-ui.js';
    head.appendChild(script);

    const pluginSkinScript = doc.createElement('script');
    pluginSkinScript.src = mainBase + 'plugin-comfyui.js';
    head.appendChild(pluginSkinScript);

    console.log(`[Plugin] assets injected into iframe — tokens.css + anoclaw-ui.js`);
    this._tokensInjected = true;
  }

  private _updateIframeThemeAttrs(): void {
    if (!this._iframe?.contentDocument) return;
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme') || 'dark';
    const accent = root.getAttribute('data-accent') || 'white';
    const docEl = this._iframe.contentDocument.documentElement;
    docEl.setAttribute('data-theme', theme);
    docEl.setAttribute('data-accent', accent); // always set, 'white' is harmless in tokens.css
  }
}
