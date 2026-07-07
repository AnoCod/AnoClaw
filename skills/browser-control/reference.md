# Browser Control — Full API Reference

Covers both **Mode A (browser-use MCP)** and **Mode B (CDP Direct)**. Use the mode tags `[A]` / `[B]` to filter.

---

## Navigation

| Tool / Method | Mode | Key Params | Returns |
|---------------|------|------------|---------|
| `navigate_page` | A | `{ type: "url", url: "https://..." }` | Final page URL |
| `navigate_page` | A | `{ type: "back" }` | — |
| `navigate_page` | A | `{ type: "forward" }` | — |
| `navigate_page` | A | `{ type: "reload" }` | — |
| `Page.navigate` | B | `{ url: "https://..." }` | `{ frameId, loaderId }` |
| `Page.reload` | B | `{}` | — |
| `Page.goBack` | B | `{}` | — |
| `Page.goForward` | B | `{}` | — |

**Mode A navigation:**
```
navigate_page → { type: "url", url: "http://localhost:3000" }
```

**Mode B navigation (via script):**
```bash
node scripts/cdp-navigate.js "http://localhost:3000"
node scripts/cdp-navigate.js "http://localhost:3000" --new-tab
```

---

## Page Snapshot & Element Discovery

| Tool / Method | Mode | Description |
|---------------|------|-------------|
| `take_snapshot` | A | Accessibility tree as text. Each interactive element gets `uid` (e.g., `@e34`, `@btn-7`) |
| `take_snapshot` | A | `{ verbose: true }` — includes ALL elements |
| `take_snapshot` | A | `{ filePath: "/abs/path.txt" }` — save to file |
| `DOM.getDocument` | B | Returns root node with `nodeId` |
| `DOM.querySelector` | B | `{ nodeId, selector }` → `nodeId` |
| `DOM.querySelectorAll` | B | `{ nodeId, selector }` → `nodeIds[]` |
| `Runtime.evaluate` | B | `querySelector(...)` directly — simpler than DOM domain |

**Mode A snapshot pattern:**
```
take_snapshot →
  [uid: @e1] heading "Login"
  [uid: @e3] textbox "Email"
  [uid: @e5] textbox "Password"
  [uid: @e7] button "Sign In"
→ Use @e3, @e5, @e7 in subsequent fill/click calls
```

**Mode B element discovery:**
```js
// Runtime.evaluate
`(()=>{
  const inputs = document.querySelectorAll('input, textarea, select, [role="textbox"]');
  return [...inputs].map(el => ({
    tag: el.tagName,
    type: el.type || el.getAttribute('role'),
    name: el.name || el.placeholder || el.getAttribute('aria-label'),
    id: el.id,
    className: el.className.slice(0, 60)
  }));
})()`
```

---

## Interaction

### Click

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `click` | A | `{ uid: "@e7" }` |
| `click` | A | `{ uid: "@e7", dblClick: true }` — double-click |
| `Runtime.evaluate` | B | `document.querySelector('...').click()` |
| `Input.dispatchMouseEvent` | B | `{ type, x, y, button, clickCount }` — low-level |

### Fill / Type

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `fill` | A | `{ uid: "@e3", value: "text" }` — clears first, then types |
| `Runtime.evaluate` | B | See typing patterns below |

**Mode B typing — contenteditable / rich text editors:**
```js
`(()=>{
  const el = document.querySelector('[role="textbox"]');
  el.focus();
  el.innerHTML = '<p>your text</p>';
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
})()`
```

**Mode B typing — React controlled inputs:**
```js
`(()=>{
  const el = document.querySelector('#email');
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  ).set;
  nativeSetter.call(el, 'user@email.com');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`
```

### Keyboard

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `press_key` | A | `{ key: "Enter" }` |
| `Input.dispatchKeyEvent` | B | `{ type: "keyDown", key: "Enter", code: "Enter", keyCode: 13 }` |

### Hover / Drag

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `hover` | A | `{ uid: "@e10" }` |
| `drag` | A | `{ uid: "@e10", targetUid: "@e20" }` |

### Upload

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `upload_file` | A | `{ uid: "@file-input", filePath: "/abs/path/to/file" }` |

---

## JavaScript Execution (evaluate_script)

**The most powerful tool in both modes.** Run arbitrary JS in the page context.

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `evaluate_script` | A | `{ function: "() => { ... }" }` — arrow function string |
| `Runtime.evaluate` | B | `{ expression: "() => { ... }", returnByValue: true }` |
| `Runtime.evaluate` | B | `{ expression: "await fetch(...)", awaitPromise: true }` — async |

**Mode A pattern:**
```
evaluate_script → { function: "() => document.querySelectorAll('.item').length" }
→ 42
```

**Mode B pattern:**
```js
// Via WebSocket
{ id: 1, method: 'Runtime.evaluate',
  params: { expression: 'document.title', returnByValue: true } }
→ { result: { value: "Page Title" } }
```

### Essential evaluate_script Recipes

**Element visibility check:**
```js
`() => {
  const el = document.querySelector('.my-element');
  return {
    exists: !!el,
    visible: !!(el && el.offsetParent),
    text: el?.textContent?.trim(),
    attributes: el ? [...el.attributes].map(a => a.name + '=' + a.value) : []
  };
}`
```

**Batch element validation:**
```js
`() => {
  const selectors = ['.header', '.main-content', '.footer', 'button.submit'];
  return selectors.map(sel => ({
    selector: sel,
    exists: !!document.querySelector(sel),
    visible: !!(document.querySelector(sel)?.offsetParent)
  }));
}`
```

**Page metadata (title, headings, links, images):**
```js
`() => ({
  title: document.title,
  url: location.href,
  headings: [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.trim()),
  linkCount: document.querySelectorAll('a').length,
  imageCount: document.querySelectorAll('img').length
})`
```

**React component state (Mode A / B):**
```js
`() => {
  const root = document.getElementById('root');
  const key = Object.keys(root).find(k => k.startsWith('__reactFiber'));
  if (!key) return 'No React detected';
  let fiber = root[key];
  let depth = 0;
  while (fiber && depth < 50) {
    if (fiber.memoizedState) {
      return { found: true, stateKeys: Object.keys(fiber.memoizedState) };
    }
    fiber = fiber.child || fiber.sibling || fiber.return;
    depth++;
  }
  return 'No state found in first 50 nodes';
}`
```

**Vue 3 component state (Mode A / B):**
```js
`() => {
  const app = document.getElementById('app').__vue_app__;
  if (!app) return 'No Vue app detected';
  return { hasApp: true };
}`
```

**Performance timing:**
```js
`() => {
  const t = performance.timing;
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
    pageLoad: t.loadEventEnd - t.navigationStart,
    firstPaint: performance.getEntriesByName('first-paint')[0]?.startTime,
    firstContentfulPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    dnsTime: t.domainLookupEnd - t.domainLookupStart,
    ttfb: t.responseStart - t.requestStart
  };
}`
```

---

## Console Log Capture

| Tool / Method | Mode | Params | Notes |
|---------------|------|--------|-------|
| `list_console_messages` | A | `{ types: ["error", "warn", "info", "log"] }` | Filtered snapshot |
| `Runtime.enable` + listen | B | `{}` → listen for `Runtime.consoleAPICalled` | Real-time stream |

**Mode A:**
```
list_console_messages → { types: ["error", "warn"] }
→ [{ type: "error", text: "Uncaught TypeError: ..." }]
```

**Mode B (via cdp-network.js-like pattern):**
Enable `Runtime.enable`, then filter incoming events where `method === 'Runtime.consoleAPICalled'`.

---

## Network Monitoring

| Tool / Method | Mode | Params | Notes |
|---------------|------|--------|-------|
| `list_network_requests` | A | `{ resourceTypes: ["fetch", "xhr"] }` | Snapshot of captured requests |
| `list_network_requests` | A | `{ resourceTypes: ["fetch"], includeBody: true }` | Includes response bodies |
| `Network.enable` + listen | B | `{}` → listen for events | Real-time stream |

**Mode A:**
```
list_network_requests → { resourceTypes: ["fetch", "xhr"] }
→ [{ url: "/api/users", method: "GET", status: 200, ... }]
```

**Mode B:**
```bash
node scripts/cdp-network.js --duration 15 --filter "api" --url-pattern "dashboard"
```
Or inline: `Network.enable` → listen for `Network.requestWillBeSent` and `Network.responseReceived` events.

---

## Screenshots

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `take_screenshot` | A | `{ filePath: "/path/to/file.png" }` |
| `take_screenshot` | A | `{ fullPage: true }` — entire scrollable page |
| `take_screenshot` | A | `{ uid: "@e20" }` — element-only |
| `take_screenshot` | A | `{ format: "jpeg", quality: 80 }` |
| `Page.captureScreenshot` | B | `{ format: "png" }` → base64 string |

---

## Tab / Page Management

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `list_pages` | A | — |
| `select_page` | A | `{ pageIdx: 2 }` |
| `/json` | B | GET → list all targets |
| `/json/new?url=...` | B | **PUT** → open new tab |
| `/json/close/{id}` | B | GET → close tab |
| `/json/activate/{id}` | B | GET → bring to foreground |

---

## Dialog Handling

| Tool / Method | Mode | Params |
|---------------|------|--------|
| `handle_dialog` | A | `{ accept: true }` — accept alert/confirm |
| `handle_dialog` | A | `{ accept: false }` — dismiss |
| `handle_dialog` | A | `{ promptText: "input" }` — fill prompt |

---

## Mode B HTTP Discovery Endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/json/version` | GET | `{ Browser, "Protocol-Version", webSocketDebuggerUrl }` |
| `/json` | GET | `[{ id, title, url, webSocketDebuggerUrl, type }]` |
| `/json/new?url=...` | **PUT** | `{ id, url }` — opens new tab |
| `/json/close/{id}` | GET | Closes target |
| `/json/activate/{id}` | GET | Brings target to front |

---

## Mode B: Full CDP Domain Reference

### Runtime — JavaScript Execution

```
Runtime.enable          → Start receiving console events
Runtime.evaluate        → Execute expression, get result
Runtime.callFunctionOn  → Call function on remote object
```

### DOM — DOM Tree Access

```
DOM.enable              → Start receiving DOM events
DOM.getDocument         → Get root node (depth param controls tree depth)
DOM.querySelector       → Find single element by CSS
DOM.querySelectorAll    → Find all matching elements
DOM.getOuterHTML        → Get element HTML string
DOM.getAttributes       → Get element attributes
DOM.setAttributeValue   → Set attribute on element
```

### Page — Navigation and Capture

```
Page.navigate           → Navigate to URL
Page.reload             → Reload current page
Page.goBack / goForward → History navigation
Page.captureScreenshot  → Screenshot as base64
Page.printToPDF         → PDF export as base64
```

### Network — Request Monitoring

```
Network.enable          → Start capturing
Network.setCacheDisabled → Toggle cache

Events:
  Network.requestWillBeSent  → { requestId, request: { url, method, headers, postData } }
  Network.responseReceived   → { requestId, response: { url, status, statusText, headers, mimeType } }
  Network.loadingFinished    → { requestId, encodedDataLength }
  Network.loadingFailed      → { requestId, errorText, type }
```

### Input — Keyboard and Mouse

```
Input.dispatchKeyEvent   → { type: "keyDown"|"keyUp", key, code, keyCode, modifiers? }
Input.dispatchMouseEvent → { type, x, y, button, clickCount }
Input.dispatchTouchEvent → { type, touchPoints[] }
```

### Emulation — Device Mimicry

```
Emulation.setUserAgentOverride     → { userAgent, acceptLanguage?, platform? }
Emulation.setDeviceMetricsOverride → { width, height, deviceScaleFactor, mobile }
```
