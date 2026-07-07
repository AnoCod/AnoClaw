# Browser Control — Usage Scenarios

Each scenario begins with a **Mode Selection** block explaining why that mode is right for this case.

---

## Scenario 1: Testing a Login Form on Your Own App

**🟢 Mode: A (browser-use)** — localhost app, no bot detection, need screenshots + console.

### Steps

```
1. Navigate to login page
   navigate_page → { type: "url", url: "http://localhost:3000/login" }

2. Snapshot to discover form elements
   take_snapshot →
     [uid: @e1] textbox "Email"
     [uid: @e2] textbox "Password"
     [uid: @e3] button "Sign In"

3. Fill credentials
   fill → { uid: "@e1", value: "user@example.com" }
   fill → { uid: "@e2", value: "securepass123" }

4. Submit form
   click → { uid: "@e3" }

5. Wait for redirect
   wait_for → { text: "Dashboard", timeout: 10000 }

6. Verify no JS errors
   list_console_messages → { types: ["error"] }
   → Expected: empty array

7. Screenshot for visual verification
   take_screenshot → { filePath: "/tmp/login-success.png" }
```

---

## Scenario 2: Chat with Gemini via Web

**🔵 Mode: B (CDP Direct)** — Google login blocks headless browsers. Need real browser profile.

### Steps

```
1. User starts Edge with debugging
   (see SKILL.md Step 1 — give the user the exact command for their shell)

2. Navigate to Gemini
   node scripts/cdp-navigate.js "https://gemini.google.com"

3. Verify logged in (Google session active)
   node scripts/cdp-extract.js --title
   → "Google Gemini" (NOT "Sign in - Google Accounts")

4. Ask a question
   node scripts/cdp-chat.js "用一句话介绍你自己"

5. Read response (script auto-polls and prints)
   → "我是一个既懂点冷幽默、又能提供硬核支持的AI合作伙伴..."
```

### If Not Logged In

If step 3 returns a sign-in page title:
> "Please log into your Google account in the Edge window, then I'll retry."

---

## Scenario 3: Scrape Product Data from a Public E-commerce Site

**🟢 Mode: A (browser-use)** — public site, no auth needed, needs structured data extraction.

### Steps

```
1. Navigate to product listing
   navigate_page → { type: "url", url: "https://example.com/products" }

2. Wait for dynamic content
   wait_for → { text: "Showing", timeout: 10000 }

3. Extract product data via evaluate_script
   evaluate_script → {
     function: `() => {
       const items = document.querySelectorAll('.product-card');
       return [...items].map(card => ({
         name: card.querySelector('.name')?.textContent.trim(),
         price: card.querySelector('.price')?.textContent.trim(),
         link: card.querySelector('a')?.href
       }));
     }`
   }
   → [{ name: "Widget A", price: "$19.99", link: "..." }, ...]

4. Check console for any load errors
   list_console_messages → { types: ["error"] }
```

---

## Scenario 4: Access Internal Dashboard Behind SSO

**🔵 Mode: B (CDP Direct)** — SSO login can't be automated. Reuse real browser session.

### Steps

```
1. User logs into dashboard normally in Edge

2. User starts Edge with --remote-debugging-port=9222

3. Navigate to dashboard page
   node scripts/cdp-navigate.js "https://internal.company.com/dashboard"

4. Verify the page loaded (not redirected to SSO login)
   node scripts/cdp-extract.js --title
   → "Company Dashboard" (not "Sign In")

5. Read data from the page
   node scripts/cdp-extract.js --selector ".data-grid"

6. Execute multi-step workflow
   node -e "(inline CDP script that clicks through navigation)"
```

---

## Scenario 5: Form Automation on a Cloudflare-Protected Site

**🔵 Mode: B (CDP Direct)** — Cloudflare's JS challenge blocks headless browsers.

### Steps

```
1. User starts Edge with --remote-debugging-port=9222
   (Cloudflare sees a real browser → challenge passes automatically)

2. Navigate to form page
   node scripts/cdp-navigate.js "https://protected-site.com/form"

3. Discover form fields
   node -e "inline script that runs: document.querySelectorAll('input, textarea, select')"

4. Fill each field using React-compatible method
   // For each field:
   Runtime.evaluate → nativeSetter.call(el, value) + dispatchEvent('input')

5. Click submit
   Runtime.evaluate → document.querySelector('button[type="submit"]').click()

6. Verify success
   Poll body.innerText for "Thank you" or URL change
```

---

## Scenario 6: Network Request Debugging

**🔵 Mode: B (CDP Direct)** — easier to capture raw CDP events with full request/response details.

### Steps

```
1. Navigate to the page
   node scripts/cdp-navigate.js "https://app.example.com"

2. Start network monitoring (new terminal)
   node scripts/cdp-network.js --duration 30 --filter "api"

3. Perform the action that triggers API calls (in browser or via CDP)

4. Review captured requests:
   ✅ [200] POST   https://app.example.com/api/login
   ✅ [200] GET    https://app.example.com/api/user/profile
   ❌ [500] GET    https://app.example.com/api/notifications
```

---

## Scenario 7: Console Error Detective Work

**🟢 Mode: A (browser-use)** — dedicated `list_console_messages` with type filtering.

### Steps

```
1. Navigate to the page under test
   navigate_page → { type: "url", url: "http://localhost:5173" }

2. Trigger the buggy interaction
   click → { uid: "@buggy-button" }

3. Capture console errors with full stack trace
   list_console_messages → { types: ["error", "warn"] }
   → [
     { type: "error", text: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')",
       stackTrace: "at processData (app.js:42:15)\n  at onClick (app.js:28:3)" }
   ]

4. Use evaluate_script to verify the fix
   evaluate_script → { function: "() => typeof window.userData === 'object'" }
```

---

## Scenario 8: Visual Regression Testing

**🟢 Mode: A (browser-use)** — built-in screenshots with element and full-page options.

### Steps

```
1. Navigate to the page
   navigate_page → { type: "url", url: "http://localhost:3000" }

2. Wait for render
   wait_for → { text: "Ready", timeout: 15000 }

3. Capture full-page screenshot
   take_screenshot → { filePath: "/tmp/current.png", fullPage: true }

4. Capture specific component
   take_snapshot → find uid of target component
   take_screenshot → { uid: "@target", filePath: "/tmp/component.png" }
```

---

## Scenario 9: Multi-Tab Workflow

**🔵 Mode: B (CDP Direct)** — CDP gives direct tab management via HTTP endpoints.

### Steps

```
1. Open three tabs
   node scripts/cdp-navigate.js "https://dashboard.com" --new-tab
   node scripts/cdp-navigate.js "https://analytics.com" --new-tab
   node scripts/cdp-navigate.js "https://admin.com" --new-tab

2. List all tabs
   curl http://localhost:9222/json

3. Connect to specific tab by URL filter
   node scripts/cdp-extract.js --url-pattern "dashboard" --selector ".stats"

4. Execute across tabs
   (Separate WebSocket connections to each tab's webSocketDebuggerUrl)
```

---

## Scenario 10: Quick One-Off Content Extraction

**🔵 Mode: B (CDP Direct)** — no MCP server needed. Fastest path to get data.

### Steps

```
1. User starts Edge with --remote-debugging-port=9222

2. User navigates to the page manually

3. Agent extracts content
   node scripts/cdp-extract.js --title
   node scripts/cdp-extract.js --selector ".main-content"
   node scripts/cdp-extract.js

4. Done — no login, no setup, just reads what's on screen
```

---

## Mode Selection Summary

| If you see this... | Choose... | Because... |
|-------------------|-----------|------------|
| `http://localhost:...` | Mode A | Your own app, no restrictions |
| "Sign in with Google" | Mode B | Bot detection, need real browser |
| Cloudflare "Checking..." | Mode B | JS challenge, need real browser |
| SSO redirect loop | Mode B | Can't automate SSO, need existing session |
| Public product listing | Mode A | No auth, optimized for scraping |
| "Please enable JavaScript" | Either | Both execute JS. Mode A for convenience |
| Need screenshot | Mode A | Built-in tool |
| Need network trace | Mode B | Easier raw CDP events |
| Quick "what's on this page?" | Mode B | No MCP server needed |
| Automated CI pipeline | Mode A | Headless, deterministic |
