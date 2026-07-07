// cdp-chat.js — Type text into AI chat (Gemini/ChatGPT/Claude) and read response
// Usage: node cdp-chat.js "你的问题"
//        node cdp-chat.js "你的问题" --url-pattern "gemini"
//        node cdp-chat.js "你的问题" --poll-sec 4 --max-wait 60

const http = require('http');

const text = process.argv[2];
if (!text) {
  console.log('Usage: node cdp-chat.js "your question" [--url-pattern "gemini"] [--poll-sec 4] [--max-wait 60]');
  process.exit(1);
}

const args = process.argv.slice(2);
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;
const pollSec = args.includes('--poll-sec') ? parseInt(args[args.indexOf('--poll-sec') + 1]) : 3;
const maxWait = args.includes('--max-wait') ? parseInt(args[args.indexOf('--max-wait') + 1]) : 60;

console.log('🔍 Connecting to browser...');

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
    let pollCount = 0;
    let prevLen = 0;

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      // Step 1: Type text into input
      if (msg.id === 1) {
        console.log('⌨️  Typing:', text.slice(0, 80));
        ws.send(JSON.stringify({
          id: 10,
          method: 'Runtime.evaluate',
          params: {
            expression: `(()=>{
              const el=document.querySelector('div[role="textbox"], textarea, [contenteditable="true"], input[type="text"]');
              if(!el)return 'NO_INPUT';
              el.focus();
              if(el.getAttribute('role')==='textbox'||el.getAttribute('contenteditable')){
                el.innerHTML='<p>${text.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '</p><p>')}</p>';
                el.dispatchEvent(new InputEvent('input',{bubbles:true}));
              } else {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${text.replace(/'/g, "\\'").replace(/"/g, '\\"')}');
                el.dispatchEvent(new Event('input',{bubbles:true}));
              }
              return 'TYPED';
            })()`,
            returnByValue: true
          }
        }));
      }

      // Step 2: Click send button
      if (msg.id === 10) {
        console.log('   Result:', msg.result?.result?.value);
        console.log('🖱️  Clicking send...');
        ws.send(JSON.stringify({
          id: 20,
          method: 'Runtime.evaluate',
          params: {
            expression: `(()=>{
              const btn=document.querySelector('button[aria-label*="Send"], button[aria-label*="send"], button[aria-label*="发送"], button[type="submit"], [data-testid="send-button"]');
              if(btn){btn.click();return 'CLICKED:'+btn.tagName;}
              const btns=document.querySelectorAll('button');
              if(btns.length>0){btns[btns.length-1].click();return 'LAST_BTN';}
              return 'NO_BTN';
            })()`,
            returnByValue: true
          }
        }));
      }

      // Step 3: Start polling for response
      if (msg.id === 20) {
        console.log('   Click:', msg.result?.result?.value);
        console.log('⏳ Waiting for response...');
        prevLen = 0;

        const poll = () => {
          pollCount++;
          if (pollCount * pollSec > maxWait) {
            console.log('⏰ Timeout after', maxWait, 's');
            ws.close();
            process.exit(0);
          }
          ws.send(JSON.stringify({
            id: 30 + pollCount,
            method: 'Runtime.evaluate',
            params: {
              expression: '(()=>{const t=document.body.innerText;return t.length+JSON.stringify({len:t.length,last:t.slice(-2000)})})()',
              returnByValue: true
            }
          }));
        };

        const interval = setInterval(poll, pollSec * 1000);
        poll(); // First poll immediately

        ws._pollHandler = (msg) => {
          if (msg.id >= 31) {
            try {
              const raw = msg.result?.result?.value;
              if (!raw) return;
              const jsonStart = raw.indexOf('{');
              if (jsonStart < 0) return;
              const parsed = JSON.parse(raw.slice(jsonStart));
              const len = parsed.len;

              if (len > prevLen + 20) {
                prevLen = len;
                console.log('\n===== RESPONSE =====');
                console.log(parsed.last);
                console.log('====================');
                clearInterval(interval);
                ws.close();
                process.exit(0);
              }
              prevLen = len;
            } catch(_) {}
          }
        };

        // Override onmessage to also handle polls
        const origOnMsg = ws.onmessage;
        ws.onmessage = (e2) => {
          const m2 = JSON.parse(e2.data);
          if (ws._pollHandler) ws._pollHandler(m2);
        };
      }
    };

    ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
