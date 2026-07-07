// cdp-navigate.js — Navigate real browser to a URL via CDP
// Usage: node cdp-navigate.js "https://example.com"
//        node cdp-navigate.js "https://example.com" --new-tab

const http = require('http');
const targetUrl = process.argv[2];
const newTab = process.argv.includes('--new-tab');

if (!targetUrl) {
  console.log('Usage: node cdp-navigate.js <url> [--new-tab]');
  process.exit(1);
}

function listPages(callback) {
  http.get('http://localhost:9222/json', (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => callback(JSON.parse(d)));
  }).on('error', () => { console.log('❌ No browser on port 9222. Start browser with --remote-debugging-port=9222'); process.exit(1); });
}

if (newTab) {
  // Open new tab via HTTP PUT
  const u = 'http://localhost:9222/json/new?url=' + encodeURIComponent(targetUrl);
  const req = http.request(u, { method: 'PUT' }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const p = JSON.parse(d);
      console.log('✅ New tab:', p.id);
      console.log('   URL:', p.url);
      process.exit(0);
    });
  });
  req.on('error', () => { console.log('❌ Failed. Is browser running with --remote-debugging-port=9222 ?'); process.exit(1); });
  req.end();
} else {
  // Find existing page and navigate
  listPages((pages) => {
    const tab = pages.find(p => p.type === 'page');
    if (!tab) { console.log('❌ No open tab found'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: targetUrl } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        if (msg.result) {
          console.log('✅ Navigated to:', targetUrl);
          console.log('   Frame:', msg.result.frameId);
        } else {
          console.log('❌ Navigation failed:', msg.error?.message);
        }
        ws.close();
        process.exit(0);
      }
    };
    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
    setTimeout(() => { console.log('⏰ Timeout'); process.exit(1); }, 10000);
  });
}
