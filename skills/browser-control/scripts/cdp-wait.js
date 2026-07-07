// cdp-wait.js — Wait for a condition before proceeding
// Usage: node cdp-wait.js text "Success"                     → wait for text on page
//        node cdp-wait.js element "button.submit"            → wait for element to appear
//        node cdp-wait.js url "dashboard"                    → wait for URL to contain text
//        node cdp-wait.js stable 3000                        → wait for page content to stabilize (no change for N ms)
//        node cdp-wait.js text "Loaded" --timeout 20000      → custom timeout (default: 15s)

const http = require('http');

const args = process.argv.slice(2);
const action = args[0];
const param = args[1];
const timeout = args.includes('--timeout') ? parseInt(args[args.indexOf('--timeout') + 1]) : 15000;
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

if (!action) {
  console.log(`Usage:
  node cdp-wait.js text "Some Text"             wait until text appears
  node cdp-wait.js element "selector"           wait until element exists
  node cdp-wait.js url "pattern"                wait until URL contains text
  node cdp-wait.js stable [ms]                  wait for page to stop changing`);
  process.exit(1);
}

const expressions = {
  'text': `document.body.innerText.includes('${(param||'').replace(/'/g, "\\'")}')`,
  'element': `!!document.querySelector('${(param||'').replace(/'/g, "\\'")}')`,
  'url': `location.href.includes('${(param||'').replace(/'/g, "\\'")}')`
};

const pollInterval = 500;
const startTime = Date.now();

http.get('http://localhost:9222/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const pages = JSON.parse(d);
    const tab = matchUrl
      ? pages.find(p => p.type === 'page' && p.url.includes(matchUrl))
      : pages.find(p => p.type === 'page');
    if (!tab) { console.log('❌ No tab found'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      console.log(`⏳ Waiting for ${action}: "${param || 'stable'}"...`);

      let lastLen = 0;
      let stableStart = 0;

      const poll = setInterval(() => {
        if (Date.now() - startTime > timeout) {
          clearInterval(poll);
          console.log(`⏰ Timeout after ${timeout}ms`);
          ws.close();
          process.exit(1);
        }

        const expr = action === 'stable'
          ? `(()=>{const l=document.body.innerText.length;return l})()`
          : expressions[action];

        ws.send(JSON.stringify({
          id: Date.now(),
          method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true }
        }));
      }, pollInterval);

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (!msg.id) return;
        const val = msg.result?.result?.value;

        if (action === 'stable') {
          if (typeof val === 'number') {
            if (val === lastLen) {
              if (!stableStart) stableStart = Date.now();
              const stableMs = parseInt(param) || 2000;
              if (Date.now() - stableStart >= stableMs) {
                clearInterval(poll);
                const elapsed = Date.now() - startTime;
                console.log(`✅ Page stable after ${elapsed}ms (content length: ${val})`);
                ws.close();
                process.exit(0);
              }
            } else {
              stableStart = 0;
              lastLen = val;
            }
          }
        } else {
          if (val === true) {
            clearInterval(poll);
            const elapsed = Date.now() - startTime;
            console.log(`✅ Condition met in ${elapsed}ms`);
            ws.close();
            process.exit(0);
          }
        }
      };
    };
    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
