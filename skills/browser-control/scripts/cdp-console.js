// cdp-console.js — Capture console messages from real browser
// Usage: node cdp-console.js --duration 5
//        node cdp-console.js --duration 10 --types error,warn
//        node cdp-console.js --duration 15 --filter "TypeError"

const http = require('http');

const args = process.argv.slice(2);
const duration = args.includes('--duration') ? parseInt(args[args.indexOf('--duration') + 1]) : 5;
const typesFilter = args.includes('--types') ? args[args.indexOf('--types') + 1].split(',') : null;
const textFilter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : null;
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

console.log(`📡 Capturing console for ${duration}s...`);
if (typesFilter) console.log(`   Types: ${typesFilter.join(', ')}`);
if (textFilter) console.log(`   Filter: "${textFilter}"`);

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
    const messages = [];
    const startTime = Date.now();
    let count = 0;

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.method === 'Runtime.consoleAPICalled') {
        const entry = {
          type: msg.params.type,
          args: msg.params.args?.map(a => a.value ?? a.description ?? a.type ?? '').join(' '),
          url: msg.params.stackTrace?.callFrames?.[0]?.url || '',
          line: msg.params.stackTrace?.callFrames?.[0]?.lineNumber || '',
          col: msg.params.stackTrace?.callFrames?.[0]?.columnNumber || '',
          time: Date.now() - startTime
        };

        if (typesFilter && !typesFilter.includes(entry.type)) return;
        if (textFilter && !entry.args.includes(textFilter) && !entry.url.includes(textFilter)) return;

        messages.push(entry);
        count++;

        const icon = { error: '❌', warn: '⚠️', info: 'ℹ️', log: '📝', debug: '🔍', trace: '📍' }[entry.type] || '📝';
        const location = entry.url ? ` (${entry.url.split('/').pop()}:${entry.line})` : '';
        console.log(`${icon} [${entry.type.toUpperCase()}] ${entry.args.slice(0, 200)}${location}`);
      }
    };

    setTimeout(() => {
      console.log(`\n📊 Results: ${messages.length} messages captured`);

      // Summary by type
      const byType = {};
      messages.forEach(m => { byType[m.type] = (byType[m.type] || 0) + 1; });
      const summary = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join('  ');
      if (summary) console.log(`   ${summary}`);

      ws.close();
      process.exit(0);
    }, duration * 1000);
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
