// cdp-network.js — Monitor network requests from real browser via CDP
// Usage: node cdp-network.js --duration 10
//        node cdp-network.js --duration 30 --filter "api"
//        node cdp-network.js --duration 15 --url-pattern "github"

const http = require('http');

const args = process.argv.slice(2);
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null;
const duration = args.includes('--duration') ? parseInt(args[args.indexOf('--duration') + 1]) : 10;

console.log(`📡 Monitoring network for ${duration}s...`);
if (filter) console.log(`   Filter: "${filter}"`);

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
    if (!tab) { console.log('❌ No tab found'); process.exit(1); }

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const requests = [];
    const startTime = Date.now();

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.method === 'Network.requestWillBeSent') {
        const req = msg.params.request;
        if (!filter || req.url.includes(filter)) {
          requests.push({
            url: req.url,
            method: req.method,
            type: msg.params.type,
            timestamp: Date.now() - startTime
          });
        }
      }

      if (msg.method === 'Network.responseReceived') {
        const resp = msg.params.response;
        const existing = requests.find(r => r.url === resp.url && !r.status);
        if (existing) {
          existing.status = resp.status;
          existing.mimeType = resp.mimeType;
          existing.statusText = resp.statusText;
        }
      }
    };

    setTimeout(() => {
      console.log(`\n📊 Results (${requests.length} requests):\n`);

      // Summary by status
      const errors = requests.filter(r => r.status >= 400);
      const pending = requests.filter(r => !r.status);
      const ok = requests.filter(r => r.status && r.status < 400);

      console.log(`   ✅ ${ok.length} OK   ❌ ${errors.length} errors   ⏳ ${pending.length} pending\n`);

      // Print all
      requests.forEach(r => {
        const status = r.status ? `[${r.status}]` : '[PENDING]';
        const icon = r.status >= 400 ? '❌' : r.status ? '✅' : '⏳';
        console.log(`${icon} ${status} ${r.method.padEnd(7)} ${r.url.slice(0, 120)}`);
        if (r.mimeType) console.log(`    → ${r.mimeType}`);
      });

      // Errors summary
      if (errors.length > 0) {
        console.log('\n⚠️  Errors:');
        errors.forEach(r => console.log(`   [${r.status}] ${r.statusText} — ${r.url.slice(0, 100)}`));
      }

      ws.close();
      process.exit(0);
    }, duration * 1000);
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
