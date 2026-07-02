# src/public/ — Frontend

## Quick Task Routing

| User asks | Touch these files |
|------|------|
| "chat broken / messages not showing" | `ts/viewmodel/ConversationViewModel.ts`, `ts/components/pages/SessionsPageMessages.ts` |
| "message rendering wrong" | `ts/components/conversation/delegates/<Type>Delegate.ts` |
| "input not working" | `ts/components/conversation/InputPanel.ts` |
| "streaming / tokens not updating" | `ts/viewmodel/ConversationViewModel.ts`, `delegates/StreamingMessageDelegate.ts` |
| "session list / tree broken" | `ts/viewmodel/SessionListModel.ts`, `ts/components/pages/SessionEdgeBar.ts` |
| "navigation dock broken" | `ts/components/TitleBar.ts` (topbar page switcher replaces dock) |
| "page switcher missing entries" | `ts/components/TitleBar.ts` — check `KERNEL_PAGES` + `setPluginPages()` |
| "plugin page blank" | `ts/components/pages/PluginPageContainer.ts` — check htmlPath + iframe sandbox |
| "plugins page not showing" | `ts/components/pages/PluginsPage.ts`, `ts/viewmodel/PluginViewModel.ts` |
| "tab switching broken" | `ts/components/pages/SessionsPageTabs.ts` |
| "agent org chart broken" | `ts/components/pages/AgentsPage.ts` |
| "star rating / quality scores" | `ts/components/evolution/StarRating.ts` |
| "session tags / tag chips" | `ts/viewmodel/ConversationViewModel.ts` (auto-tag display) |
| "settings form broken" | `ts/components/pages/SettingsPage.ts` |
| "dialog / modal broken" | `ts/components/ConfirmDialog.ts` |
| "toast not showing" | `ts/ToastManager.ts` |
| "WebSocket reconnect broken" | `ts/viewmodel/WSClient.ts` |
| "WS message routing broken" | `ts/viewmodel/WSMessageRouter.ts`, `ts/handlers/ChatHandlers.ts` |
| "new WS message handler" | Create `ts/handlers/XxxHandlers.ts` → register in `app.ts` |
| "CSS / layout / theme" | `css/layout.css` (main grid/panels/workspace), `css/layout-core.css` (variables/structure), `css/layout-chat.css` (chat + session tree), `css/layout-delegates.css` (message delegates), `css/layout-delegate-cards.css` (think/todo/plan/delegation), `css/layout-log-panel.css` (sub-sessions), `css/layout-panels.css` (shared components), `css/theme.css` |
| "dark/light mode broken" | `css/theme.css` — check `[data-theme="light"]` overrides |
| "accent color broken" | `css/theme.css` — check `[data-accent="..."]` selectors |
| "session tree styling" | `css/layout-chat.css` — `.stp-*` / `.stn-*` classes |
| "log panel styling" | `css/layout-log-panel.css` — `.log-panel*` / `.log-entry*` classes |
| "skills page styling" | `css/layout-page-components.css` — `.skill-*` classes |
| "agents page styling" | `css/layout-page-agents.css` — `.ag-*` classes |
| "files tab / file preview" | `css/layout-page-files.css` — `.tab-files-*`, `.file-preview-*` classes |
| "ask-user card styling" | `css/layout-page-files.css` — `.ask-user-*` classes |
| "message delegate styling" | `css/layout-delegates.css` (user/agent/streaming), `css/layout-delegate-cards.css` (think/todo/plan/system/delegation) |
| "new page" | `ts/PageRegistry.ts` → create `ts/components/pages/NewPage.ts` |
| "new message type" | `ts/components/conversation/delegates/` → register in message rendering |
| "file preview / markdown" | `ts/components/tabs/FilePreview.ts` |
| "sub-session card broken" | `ts/components/pages/SessionsPageSupervision.ts`, `delegates/SubSessionCardDelegate.ts` |
| "workspace / file tree / tabs broken" | `ts/components/pages/workspace/WorkspacePage.ts`, `WorkspaceFileTree.ts`, `WorkspaceTabGroup.ts` |
| "browser tab / WebContentsView" | `ts/components/pages/workspace/WorkspaceTabGroup.ts` — `_showBrowser()`, `_createBrowserTab()` |
| "Monaco editor / code tabs" | `ts/components/pages/workspace/WorkspaceTabGroup.ts` — `_showCodeEditor()`, `_initMonaco()` |
| "workspace API (browse/read/write)" | backend `src/server/` gateway routes for `/api/v1/workspace/*` + `WorkspaceFileTree.ts` consumer |

## Adding a New Page

1. Create `src/public/ts/components/pages/YourPage.ts`:
   ```ts
   export class YourPage {
     private container: HTMLElement;
     constructor(container: HTMLElement) { this.container = container; }
     render(): void { /* build DOM */ }
     destroy(): void { /* cleanup event listeners */ }
   }
   ```
2. Register in `src/public/ts/PageRegistry.ts`
3. Match CSS variables from the chosen `design-md/<brand>/DESIGN.md`
4. Build: `npm run build:frontend`

## Adding a New Message Delegate

1. Create `src/public/ts/components/conversation/delegates/YourDelegate.ts`
2. Implement the delegate pattern: `render(container, message) → HTMLElement`
3. Register in the message rendering pipeline in `SessionsPageMessages.ts`
4. Build: `npm run build:frontend`

## Component Pattern

Every component follows this pattern:
```ts
import { EventEmitter } from '../EventEmitter.js';
export class MyComponent extends EventEmitter {
  private container: HTMLElement;
  constructor(container: HTMLElement) { super(); this.container = container; }
  render(): void { /* Pure DOM creation — no innerHTML for user content */ }
  destroy(): void { /* Remove listeners, clear container */ }
}
```
- Extend `EventEmitter` for parent-child communication
- Never call another component's methods directly — emit events
- Query selectors stay scoped to `this.container`

## File Map

```
src/public/
├── index.html                              # SPA entry
├── css/
│   ├── layout.css                           # Main layout — grid, panels, workspace, toolbar, pages
│   ├── layout-cinema.css                   # Cinema minimalism layout (Sessions B direction)
│   ├── layout-core.css                     # Layout CSS variables, page structure, legacy, scrollbar
│   ├── layout-chat.css                     # Session tree panel, tree nodes, tab header, context ring, mode menu, supervision controls
│   ├── layout-delegates.css                # User, agent, markdown, streaming message delegates
│   ├── layout-delegate-cards.css           # Think, todo, plan, system, delegation activity delegates
│   ├── layout-log-panel.css                # Sub-session cards + floating log panel
│   ├── layout-panels.css                   # Shared: panel-header, form-field, btn, dialog, settings dialog, toggle, range slider
│   ├── layout-page-components.css          # SkillsPage: skill cards grid, editor/import modals, toggle, shared modal title
│   ├── layout-page-files.css               # FilesTab, file preview, context menu, AskUser interactive card
│   ├── layout-pages.css                    # OverviewTab, PlanTab
│   ├── layout-page-agents.css              # AgentsPage: org chart pan/zoom, agent cards + modals
│   ├── layout-input.css                    # Input panel, attachments, slash popup, mode selector
│   ├── layout-motion.css                   # Raycast micro-interactions: page transition, keycap, shimmer
│   └── theme.css                           # Raycast-inspired: surface ladder, typography, data-theme|accent
├── ts/
│   ├── app.ts                              # App entry, page reg, WS bridge
│   ├── PageRegistry.ts                     # Route → page component
│   ├── MarkdownRenderer.ts                 # ★ Unified markdown → safe HTML renderer
│   ├── ToastManager.ts                     # Toast notifications
│   ├── ClientLogger.ts                     # Frontend→backend logger
│   ├── EventEmitter.ts                     # Simple typed EventEmitter base class
│   ├── types.ts                            # Frontend-only type definitions
│   ├── handlers/
│   │   └── ChatHandlers.ts                 # Chat WS events → ConversationViewModel
│   ├── utils/
│   │   └── colorUtils.ts                   # Color parsing, manipulation helpers
│   ├── viewmodel/
│   │   ├── WSClient.ts                     # ★ WebSocket (auto-reconnect, queue)
│   │   ├── WSMessageRouter.ts              # Pluggable WS event dispatch
│   │   ├── SessionViewModel.ts             # Session CRUD + WS
│   │   ├── SessionListModel.ts             # Session list state
│   │   ├── ConversationViewModel.ts        # ★ Streaming messages, lifecycle, sendMessage
│   │   ├── ConversationWsHandlers.ts       # WS event handlers (think, text, tool, delegation, etc.)
│   │   ├── MessageListModel.ts             # Message data model
│   │   ├── AgentViewModel.ts               # Agent config
│   │   └── PluginViewModel.ts              # Plugin list + page contributions + toggle/reload/uninstall
│   ├── components/
│   │   ├── TitleBar.ts                     # Top bar — KERNEL_PAGES + setPluginPages() for dynamic plugin entries
│   │   ├── ConfirmDialog.ts                # Generic confirm
│   │   ├── LogPanel.ts                     # Floating log panel for sub-session output
│   │   ├── WorkspaceDialog.ts              # Workspace binding
│   │   ├── WorkspaceBindingDialog.ts       # Workspace folder picker
│   │   ├── pages/
│   │   │   ├── workspace/
│   │   │   │   ├── WorkspacePage.ts           # ★ Workspace page: file tree + tabbed editor/browser
│   │   │   │   ├── WorkspaceFileTree.ts       # Recursive file tree with CRUD, drag-drop, context menus
│   │   │   │   ├── WorkspaceTabGroup.ts       # ★ Tab container: Monaco editor, image/PDF/Office preview, browser WebContentsView
│   │   │   │   └── WorkspaceSplitContainer.ts # Split-view for two tab groups side-by-side
│   │   │   ├── SessionsPage.ts             # ★ Cinema full-bleed chat (delegates overfly to SessionsPageOverfly)
│   │   │   ├── SessionsPageOverfly.ts       # Right-bar overfly panels (files, overview, plan)
│   │   │   ├── SessionEdgeBar.ts           # Left 48px session dot nav
│   │   │   ├── RightEdgeBar.ts             # Right 48px info icons + overfly panels
│   │   │   ├── SessionsPageAskUser.ts      # AskUserQuestion card
│   │   │   ├── SessionsPageMessages.ts     # Message rendering pipeline
│   │   │   ├── SessionsPageTabs.ts         # Tab switching, polling, loading
│   │   │   ├── SessionsPageUtils.ts        # Escape, markdown, formatting
│   │   │   ├── SessionsPageData.ts         # Plan/memory/skill/todo collectors
│   │   │   ├── SessionsPageSupervision.ts  # Sub-session supervision
│   │   │   ├── AgentsPage.ts               # Org chart canvas
│   │   │   ├── SettingsPage.ts             # Settings
│   │   │   ├── SkillsPage.ts               # Skills
│   │   │   ├── MemoryPage.ts               # Memory
│   │   │   ├── TeamStatusPanel.ts           # Agent team status panel with live indicators
│   │   │   ├── PluginsPage.ts              # Plugin management — cinema cards, toggle/reload/uninstall
│   │   │   └── PluginPageContainer.ts      # iframe sandbox + anoclaw postMessage bridge for plugin frontends
│   │   ├── evolution/
│   │   │   └── StarRating.ts               # 1-5 star quality rating widget on messages
│   │   ├── conversation/
│   │   │   ├── InputPanel.ts               # Message input + slash popup + attachments
│   │   │   ├── MessageListView.ts          # Scrollable message list viewport
│   │   │   ├── ModeSelector.ts             # Permission mode dropdown
│   │   │   ├── SlashCommandPanel.ts        # Slash command popup
│   │   │   ├── SlashCommands.ts            # Command definitions + filtering
│   │   │   ├── SessionTreeNode.ts          # Tree node
│   │   │   ├── types.ts                    # Conversation type definitions
│   │   │   └── delegates/
│   │   │       ├── UserMessageDelegate.ts
│   │   │       ├── AgentMessageDelegate.ts
│   │   │       ├── StreamingMessageDelegate.ts  # ★ Token streaming
│   │   │       ├── ToolCallDelegate.ts
│   │   │       ├── ToolResultDelegate.ts
│   │   │       ├── ThinkDelegate.ts
│   │   │       ├── SystemMessageDelegate.ts
│   │   │       ├── TodoWriteDelegate.ts
│   │   │       ├── PlanIndicator.ts
│   │   │       ├── DelegationActivityDelegate.ts
│   │   │       ├── SubSessionCardDelegate.ts    # ★ Sub-session cards
│   │   │       ├── EditResultDelegate.ts        # Edit tool result display
│   │   │       ├── StatusDelegate.ts            # Agent status indicator
│   │   │       └── ToolActivityDelegate.ts      # Tool activity feed item
│   │   └── tabs/
│   │       ├── FilesTab.ts                 # File browser
│   │       ├── FilePreview.ts              # Markdown/code preview
│   │       ├── OverviewTab.ts              # Session overview stats
│   │       └── PlanTab.ts                  # Plan display
│   └── data/
│       └── agents/
│           └── ceo.json                    # Default CEO agent config
├── js/                                     # Build output (NEVER edit directly)
└── icons/                                  # SVG icons
```

## Conventions

1. **No framework**: Pure TS + native DOM. No React, Vue, jQuery.
2. **ESM**: `.js` extension in imports. **No path aliases** — use relative paths.
3. **EventEmitter**: Components talk via events, never direct method calls.
4. **Delegate pattern**: One Delegate per message type. New type → new Delegate.
5. **Dark theme default**: Variables in `:root`. Light: `[data-theme="light"]`. Accent: `[data-accent="name"]`.
6. **CSS variables only**: `var(--color-primary)`, never hardcoded hex.
7. **No `style.cssText`**: CSS class toggles for state. Inline only for x/y/w/h.
8. **SVG icons only**: No emoji. Inline SVG string or file in `icons/`.
9. **Safe DOM**: No `innerHTML` for user content — use `textContent` or sanitize.
10. **TODO(backend)**: Annotate backend dependencies: `// TODO(backend): expected WS format: { ... }`
11. **Comments/identifiers in English**.

## Build

```bash
npm run build:frontend   # ts/ → js/
```
- Two tsconfigs: `src/public/tsconfig.json` (build, rootDir: ts, outDir: js) and `src/public/ts/tsconfig.json` (editor). Build uses the former.
- Never edit `js/` files directly.

## Workspace Architecture

The workspace page combines a file tree with a tabbed editor/browser using Monaco and Electron WebContentsView.

**Files:**
- [WorkspacePage.ts](ts/components/pages/workspace/WorkspacePage.ts) — Page entry point. Listens for `sessionSelected` events, loads workspace binding per session, caches tab groups in `_tabCache` so switching sessions preserves tab state. Exposes `_browserGroup()` for the global `ws-open-browser-internal` event (agents create browser tabs via `executeJavaScript`).
- [WorkspaceFileTree.ts](ts/components/pages/workspace/WorkspaceFileTree.ts) — Left sidebar file tree. Lazy-loads directory children on expand. Supports right-click context menu (New File/Folder, Rename, Delete), drag-and-drop move, keyboard shortcuts (Del=delete, F2=rename), and polling every 5 seconds for external changes.
- [WorkspaceTabGroup.ts](ts/components/pages/workspace/WorkspaceTabGroup.ts) — The main tab container (~1070 lines). Handles 6 file types: code (Monaco editor with status bar), image (img tag), PDF (iframe), markdown (rendered via MarkdownRenderer), Office documents (server-side conversion to HTML), and browser (Electron WebContentsView with toolbar, navigation, element picker, console capture, screenshot). Ctrl+S saves dirty code files via `/api/v1/workspace/write`.
- [WorkspaceSplitContainer.ts](ts/components/pages/workspace/WorkspaceSplitContainer.ts) — Optional split-view: moves the active tab into a second `WorkspaceTabGroup` side-by-side with a draggable resize grip.

**API endpoints consumed:**
- `GET /api/v1/sessions/:sid/workspace` — get bound workspace path
- `PATCH /api/v1/sessions/:sid/bind-workspace` — bind workspace folder
- `GET /api/v1/workspace/browse?sessionId=&path=` — list directory
- `GET /api/v1/workspace/read?path=&sessionId=&raw=1` — read file
- `PUT /api/v1/workspace/write` — save file
- `POST /api/v1/workspace/create-file` / `create-dir` — create
- `PATCH /api/v1/workspace/rename` / `POST .../move` / `DELETE .../file` — rename/move/delete
- `GET /api/v1/workspace/convert-office` — server-side Office→HTML conversion

**IPC (Electron bridge, `window.electronAPI`):**
- `wvCreate(url)` → returns `{viewId}` — create WebContentsView
- `wvDestroy(viewId)`, `wvNavigate(viewId, url)`, `wvReload`, `wvGoBack`, `wvGoForward`
- `wvSetBounds(viewId, x, y, w, h)` — position/resize the view
- `wvExecJs(viewId, code)` — execute JS in page, returns `{ok, result}`
- `wvDevTools(viewId)`, `wvEnableContextCapture`, `wvCaptureScreenshot`
- `onWvStateChange(callback)` — loading/title/favicon events, returns cleanup function

## Design

Design token specs previously stored in `design-md/` have been removed. The project uses a Raycast-inspired dark theme defined in `css/theme.css`. For new UI work, extract tokens from existing CSS variables in `:root` and match the existing component patterns.

## Additions since File Map (not yet in map)
- `css/layout-components.css` — shared UI component styles
- `ts/components/ui/` — reusable UI kit (Button, Card, Dialog, Toggle, FormField)
- `floating-ball/` — desktop floating ball overlay (index.html, style.css, app.js)
