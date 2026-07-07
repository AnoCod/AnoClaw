---
name: browser-control
description: "Automate browser tasks - test web apps, scrape pages, debug frontend code, take screenshots, interact with web forms, and chat with AI services. Use when testing web applications, automating browser workflows, debugging UI, or any web automation task."
when_to_use: "User wants to test a website, automate browser interactions, scrape a page, take screenshots, debug frontend behavior, or interact with a web service."
triggers:
  - "browser"
  - "test the website"
  - "screenshot"
  - "scrape"
  - "web app"
  - "automate"
  - "debug frontend"
  - "playwright"
  - "puppeteer"
  - "chrome"
allowed-tools:
  - Bash
  - Read
  - Write
  - WebFetch
  - WebSearch
---

# Browser Control

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Automate browser interactions for testing, scraping, debugging, and UI automation.

## Decision: Which Tool?

| Scenario | Use |
|----------|-----|
| Read page content (public URL) | **WebFetch** - fastest, no setup |
| Search the web for information | **WebSearch** - multiple sources |
| Test a local app (localhost) | **Playwright** via Bash - full browser control |
| Debug frontend JS errors | **Playwright** - console log capture |
| Take screenshots of a page | **Playwright** - built-in `screenshot()` |
| Fill and submit forms | **Playwright** - `fill()`, `click()` |
| Interact with AI chat (Gemini/ChatGPT) | **Playwright** - handle login, chat |
| Scrape JavaScript-rendered pages | **Playwright** - execute JS in page |
| Network request monitoring | **Playwright** - `page.route()` |

## Playwright Quick Start

```bash
npm install playwright
npx playwright install chromium
```

## Core Workflow

Every interaction follows this pattern:

```
navigate -> wait -> interact -> verify -> screenshot
```

### Basic Script Template

```js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // 1. Navigate
  await page.goto('https://example.com');
  
  // 2. Wait for content
  await page.waitForSelector('h1');
  
  // 3. Interact
  await page.fill('input[name="email"]', 'user@example.com');
  await page.click('button[type="submit"]');
  
  // 4. Verify
  await page.waitForSelector('.success-message');
  const text = await page.textContent('.result');
  console.log('Result:', text);
  
  // 5. Screenshot
  await page.screenshot({ path: 'result.png', fullPage: true });
  
  await browser.close();
})();
```

## Common Patterns

### Find and Click an Element

```js
// By text
await page.click('text=Sign In');

// By CSS selector
await page.click('button.submit-btn');

// By role (accessible)
await page.click('role=button[name="Submit"]');
```

### Fill a Form

```js
await page.fill('input[name="username"]', 'john');
await page.fill('input[type="password"]', 'secret');
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard');
```

### Check for Errors

```js
// Capture console errors
const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});

// Capture network failures
page.on('requestfailed', request => {
  console.log(`${request.url()} failed: ${request.failure().errorText}`);
});

// After interaction, check for DOM errors
const errorEl = await page.$('.error-message');
if (errorEl) console.log('Error:', await errorEl.textContent());
```

### Execute JavaScript in the Page

```js
// Get page title
const title = await page.evaluate(() => document.title);

// Count elements
const count = await page.evaluate(() => document.querySelectorAll('a').length);

// Read data from the page
const items = await page.evaluate(() => 
  [...document.querySelectorAll('.item')].map(el => el.textContent)
);

// Check React/Vue component state
const reactState = await page.evaluate(() => {
  const el = document.querySelector('#root');
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  return key ? 'React detected' : 'Not React';
});
```

### Take Screenshots

```js
// Full page
await page.screenshot({ path: 'full.png', fullPage: true });

// Just the viewport
await page.screenshot({ path: 'viewport.png' });

// A specific element
const element = await page.$('.target');
await element.screenshot({ path: 'element.png' });
```

### Handle Authentication

```js
// HTTP Basic Auth
await page.authenticate({ username: 'user', password: 'pass' });

// Login form
await page.goto('https://app.example.com/login');
await page.fill('#email', 'user@example.com');
await page.fill('#password', 'secret');
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard');
```

### Wait for Content

```js
// Wait for text to appear
await page.waitForSelector('text=Loading complete');

// Wait for element
await page.waitForSelector('.data-loaded');

// Wait for network idle
await page.waitForLoadState('networkidle');

// Wait for a specific time (avoid, but sometimes necessary)
await page.waitForTimeout(2000);
```

### Network Monitoring

```js
// Log all API requests and responses
page.on('request', req => {
  if (req.url().includes('/api/')) console.log('->', req.method(), req.url());
});
page.on('response', res => {
  if (res.url().includes('/api/')) console.log('<-', res.status(), res.url());
});
```

## Testing Patterns

```js
// Test that a button click shows an element
const button = await page.$('button.show-more');
await button.click();
const content = await page.waitForSelector('.more-content');
console.assert(content, 'Content should appear after click');

// Test form validation
await page.fill('input[required]', '');
await page.click('button[type="submit"]');
const error = await page.waitForSelector('.validation-error');
console.assert(error, 'Validation error should show');
```

## When NOT to Use Playwright

- Just reading a public page -> **WebFetch** is faster
- Searching the web -> **WebSearch** with multiple sources
- Simple API calls -> just use `fetch()` or `curl` in Bash
- The user just wants to know if a site is up -> `curl -I` in Bash

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Element not found | Add `await page.waitForSelector()` before interacting |
| Click doesn't work | Try `page.click('text=Button')` or `page.locator('button').click()` |
| React form fill fails | Use `page.evaluate(() => { el.value = 'x'; el.dispatchEvent(new Event('input', {bubbles:true})); })` |
| Page takes too long | Set timeout: `page.goto(url, { timeout: 30000 })` |
| Headless detection | Set `headless: false` or add user agent |
