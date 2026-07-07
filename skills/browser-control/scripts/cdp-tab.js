// cdp-tab.js — Manage browser tabs via CDP
// Usage: node cdp-tab.js list                             → list all tabs
//        node cdp-tab.js new "https://example.com"        → open new tab
//        node cdp-tab.js close "github"                   → close tab matching URL
//        node cdp-tab.js activate "github"                → bring tab to foreground

const http = require('http');

const args = process.argv.slice(2);
const action = args[0];
const param = args[1];

if (!action) {
  console.log(`Usage:
  node cdp-tab.js list                               list all tabs
  node cdp-tab.js new "https://example.com"          open new tab
  node cdp-tab.js close "url-pattern"                close matching tab
  node cdp-tab.js activate "url-pattern"             bring to foreground`);
  process.exit(1);
}

http.get('http://localhost:9222/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const pages = JSON.parse(d).filter(p => p.type === 'page');

    switch (action) {
      case 'list':
        if (pages.length === 0) {
          console.log('No tabs open');
        } else {
          console.log(`📋 ${pages.length} tab(s):\n`);
          pages.forEach((p, i) => {
            const icon = i === 0 ? '👉' : '   ';
            console.log(`${icon} [${i}] ${p.title?.slice(0, 60) || '(untitled)'}`);
            console.log(`     ${p.url}`);
            console.log(`     id: ${p.id}`);
          });
        }
        process.exit(0);
        break;

      case 'new':
        if (!param) { console.log('❌ URL required'); process.exit(1); }
        const u = 'http://localhost:9222/json/new?url=' + encodeURIComponent(param);
        const req = http.request(u, { method: 'PUT' }, (res2) => {
          let d2 = '';
          res2.on('data', c => d2 += c);
          res2.on('end', () => {
            const p = JSON.parse(d2);
            console.log('✅ New tab opened');
            console.log(`   URL: ${p.url}`);
            console.log(`   ID: ${p.id}`);
            process.exit(0);
          });
        });
        req.end();
        break;

      case 'close':
        if (!param) { console.log('❌ URL pattern required'); process.exit(1); }
        const target = pages.find(p => p.url.includes(param));
        if (!target) { console.log('❌ No tab matching:', param); process.exit(1); }
        http.get('http://localhost:9222/json/close/' + target.id, (res2) => {
          console.log('✅ Closed tab:', target.title?.slice(0, 40));
          process.exit(0);
        });
        break;

      case 'activate':
        if (!param) { console.log('❌ URL pattern required'); process.exit(1); }
        const tab = pages.find(p => p.url.includes(param));
        if (!tab) { console.log('❌ No tab matching:', param); process.exit(1); }
        http.get('http://localhost:9222/json/activate/' + tab.id, (res2) => {
          console.log('✅ Activated:', tab.title?.slice(0, 40));
          process.exit(0);
        });
        break;

      default:
        console.log('Unknown action:', action);
        process.exit(1);
    }
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
