// cdp-snapshot.js — Discover interactive elements on the page
// Usage: node cdp-snapshot.js                          → all interactive elements
//        node cdp-snapshot.js --verbose                → all elements including non-interactive
//        node cdp-snapshot.js --selector "form"        → elements within a container
//        node cdp-snapshot.js --text "Login"           → elements containing text

const http = require('http');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const selector = args.includes('--selector') ? args[args.indexOf('--selector') + 1] : null;
const textSearch = args.includes('--text') ? args[args.indexOf('--text') + 1] : null;
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

const expr = `(()=>{
  const SEL='${(selector||'').replace(/'/g, "\\'")}';
  const TXT='${(textSearch||'').replace(/'/g, "\\'")}';
  const root=SEL?document.querySelector(SEL):document;
  if(!root)return 'SELECTOR_NOT_FOUND';

  const interactive='a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[onclick],[tabindex]';
  const verbose=${verbose};

  const els=verbose?[...root.querySelectorAll('*')]:[...root.querySelectorAll(interactive)];
  let uid=0;

  return els.filter(el=>{
    if(TXT&&!el.textContent.trim().includes(TXT))return false;
    if(!verbose&&el.offsetParent===null&&el.tagName!=='A')return false;
    return true;
  }).map(el=>{
    uid++;
    const tag=el.tagName.toLowerCase();
    const role=el.getAttribute('role')||'';
    const text=el.textContent?.trim()?.slice(0,50)||'';
    const placeholder=el.placeholder||el.getAttribute('aria-label')||'';
    const href=el.href?(el.href.length>60?el.href.slice(0,60)+'...':el.href):'';
    const value=el.value?(typeof el.value==='string'?el.value.slice(0,30):el.value):'';
    const id=el.id||'';
    const cls=el.className?.toString()?.slice(0,40)||'';
    const vis=el.offsetParent!==null?'':'[hidden]';

    return {
      uid:'@'+uid,
      tag,
      role:role||undefined,
      id:id||undefined,
      cls:cls||undefined,
      text:text||undefined,
      placeholder:placeholder||undefined,
      href:href||undefined,
      value:value||undefined,
      hidden:vis||undefined
    };
  });
})()`;

http.get('http://localhost:9222/json', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const pages = JSON.parse(d);
    const tab = matchUrl
      ? pages.find(p => p.type === 'page' && p.url.includes(matchUrl))
      : pages.find(p => p.type === 'page');
    if (!tab) { console.log('❌ No tab found'); process.exit(1); }

    console.log(`📋 Scanning: ${tab.title?.slice(0, 60) || tab.url}`);

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true }
      }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) {
        const val = msg.result?.result?.value;
        if (typeof val === 'string' && val === 'SELECTOR_NOT_FOUND') {
          console.log('❌ Container selector not found');
        } else if (Array.isArray(val)) {
          console.log(`\n📊 Found ${val.length} elements:\n`);
          val.forEach(el => {
            const parts = [el.uid, el.tag];
            if (el.role) parts.push(`role="${el.role}"`);
            if (el.id) parts.push(`#${el.id}`);
            if (el.cls) parts.push(`.${el.cls.replace(/\s+/g, '.')}`);
            if (el.text) parts.push(`"${el.text}"`);
            if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
            if (el.href) parts.push(`href="${el.href}"`);
            if (el.value) parts.push(`value="${el.value}"`);
            if (el.hidden) parts.push(el.hidden);
            console.log(`  ${parts.join(' ')}`);
          });
        } else {
          console.log('Unexpected result:', val);
        }
        ws.close();
        process.exit(0);
      }
    };
    ws.onerror = () => { console.log('❌ WS error'); process.exit(1); };
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
