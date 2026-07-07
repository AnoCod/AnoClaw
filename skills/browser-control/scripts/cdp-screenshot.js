// cdp-screenshot.js — Capture screenshot from real browser
// Usage: node cdp-screenshot.js                           → saves to ./screenshot.png
//        node cdp-screenshot.js --output ./my-shot.png    → custom path
//        node cdp-screenshot.js --url-pattern "gemini"    → target specific tab

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outputFile = args.includes('--output') ? args[args.indexOf('--output') + 1] : './screenshot.png';
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

const absPath = path.resolve(outputFile);

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
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: { format: 'png' }
      }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        if (msg.result?.data) {
          const buffer = Buffer.from(msg.result.data, 'base64');
          fs.writeFileSync(absPath, buffer);
          console.log(`✅ Screenshot saved: ${absPath} (${Math.round(buffer.length / 1024)} KB)`);
        } else {
          console.log('❌ No screenshot data received');
        }
        ws.close();
        process.exit(0);
      }
    };
    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
