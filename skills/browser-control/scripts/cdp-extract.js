// cdp-extract.js — Extract page content from real browser via CDP
// Usage: node cdp-extract.js                    → full body text
//        node cdp-extract.js --title             → page title only
//        node cdp-extract.js --selector ".main"  → specific element
//        node cdp-extract.js --url-pattern "github" → match tab by URL

const http = require('http');
const args = process.argv.slice(2);
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;
const selector = args.includes('--selector') ? args[args.indexOf('--selector') + 1] : null;
const titleOnly = args.includes('--title');

http.get('http://localhost:9222/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const pages = JSON.parse(d);
    let tab;
    if (matchUrl) {
      tab = pages.find(p => p.type === 'page' && p.url.includes(matchUrl));
    } else {
      tab = pages.find(p => p.type === 'page');
    }
    if (!tab) { console.log('❌ No matching tab found'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      let expr;
      if (titleOnly) {
        expr = 'document.title';
      } else if (selector) {
        expr = `document.querySelector('${selector.replace(/'/g, "\\'")}')?.innerText || document.querySelector('${selector.replace(/'/g, "\\'")}')?.textContent || 'NOT_FOUND'`;
      } else {
        expr = 'document.body.innerText';
      }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        const val = msg.result?.result?.value;
        if (val) {
          console.log(val);
        } else {
          console.log('(empty or no result)');
        }
        ws.close();
        process.exit(0);
      }
    };
    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
