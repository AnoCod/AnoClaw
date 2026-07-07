// cdp-eval.js — Run any JavaScript in the browser page context
// Usage: node cdp-eval.js "document.title"
//        node cdp-eval.js "document.querySelectorAll('a').length"
//        node cdp-eval.js --async "await fetch('/api/user').then(r=>r.json())"
//        node cdp-eval.js --file myScript.js        (run a file as expression)
//        node cdp-eval.js --url-pattern "gemini" "document.title"

const http = require('http');
const fs = require('fs');

const args = process.argv.slice(2);
const isAsync = args.includes('--async');
const filePath = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

// Get expression from args or file
let expression;
if (filePath) {
  expression = fs.readFileSync(filePath, 'utf8');
} else {
  // First non-flag arg is the expression
  expression = args.filter(a => !a.startsWith('--') && a !== isAsync && a !== filePath && (isAsync || a !== matchUrl))[0];
}

if (!expression) {
  console.log('Usage: node cdp-eval.js [--async] [--url-pattern "url"] [--file script.js] "expression"');
  process.exit(1);
}

http.get('http://localhost:9222/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const pages = JSON.parse(d);
    const tab = matchUrl
      ? pages.find(p => p.type === 'page' && p.url.includes(matchUrl))
      : pages.find(p => p.type === 'page');

    if (!tab) { console.log('❌ No matching tab'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.enable'
      }));
      ws.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: {
          expression: expression,
          returnByValue: true,
          awaitPromise: isAsync
        }
      }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 2) {
        if (msg.result?.result?.value !== undefined) {
          const val = msg.result.result.value;
          if (typeof val === 'object') {
            console.log(JSON.stringify(val, null, 2));
          } else {
            console.log(val);
          }
        } else if (msg.result?.exceptionDetails) {
          console.log('❌ Error:', msg.result.exceptionDetails.text || msg.result.exceptionDetails.exception?.description);
        } else {
          console.log('(no result)');
        }
        ws.close();
        process.exit(0);
      }
    };
    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
    setTimeout(() => { console.log('⏰ Timeout (10s)'); process.exit(1); }, 10000);
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
