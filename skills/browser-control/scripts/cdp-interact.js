// cdp-interact.js — Universal browser interaction via CDP
// Usage: node cdp-interact.js click "button.submit"
//        node cdp-interact.js click-text "Sign In"
//        node cdp-interact.js fill "input#email" "user@email.com"
//        node cdp-interact.js type "What is AI?"          (into focused input)
//        node cdp-interact.js key Enter
//        node cdp-interact.js scroll down 500
//        node cdp-interact.js scroll up 300
//        node cdp-interact.js scroll-to ".footer"
//        node cdp-interact.js focus "input#name"
//        node cdp-interact.js hover ".dropdown-trigger"

const http = require('http');

const args = process.argv.slice(2);
const action = args[0];
const param1 = args[1];
const param2 = args[2];
const matchUrl = args.includes('--url-pattern') ? args[args.indexOf('--url-pattern') + 1] : null;

if (!action) {
  console.log(`Usage:
  node cdp-interact.js click "selector"
  node cdp-interact.js click-text "visible text"
  node cdp-interact.js fill "selector" "value"    (React-compatible)
  node cdp-interact.js type "text"                (into active element)
  node cdp-interact.js key Enter|Tab|Escape|Space
  node cdp-interact.js scroll down|up Npx
  node cdp-interact.js scroll-to "selector"
  node cdp-interact.js focus "selector"
  node cdp-interact.js hover "selector"`);
  process.exit(1);
}

const expressions = {
  'click': `(()=>{
    const el=document.querySelector('${(param1||'').replace(/'/g, "\\'")}');
    if(!el)return 'NOT_FOUND';
    el.scrollIntoView({behavior:'smooth',block:'center'});
    el.click();
    return 'CLICKED: '+el.tagName+' '+el.className.slice(0,50);
  })()`,

  'click-text': `(()=>{
    const els=[...document.querySelectorAll('a,button,label,[role=button],[onclick],input[type=submit],div[tabindex]')];
    const target=els.find(e=>e.textContent.trim().includes('${(param1||'').replace(/'/g, "\\'")}'));
    if(!target)return 'NOT_FOUND';
    target.scrollIntoView({behavior:'smooth',block:'center'});
    target.click();
    return 'CLICKED: '+target.tagName+' "'+target.textContent.trim().slice(0,40)+'"';
  })()`,

  'fill': `(()=>{
    const el=document.querySelector('${(param1||'').replace(/'/g, "\\'")}');
    if(!el)return 'NOT_FOUND';
    el.focus();
    const desc=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
    if(desc&&desc.set){desc.set.call(el,'${(param2||'').replace(/'/g, "\\'")}');}
    else{el.value='${(param2||'').replace(/'/g, "\\'")}';}
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'FILLED: '+el.tagName+' → '+(el.value||el.textContent).slice(0,50);
  })()`,

  'type': `(()=>{
    const el=document.activeElement;
    if(!el)return 'NO_ACTIVE_ELEMENT';
    if(el.getAttribute('role')==='textbox'||el.getAttribute('contenteditable')==='true'){
      el.innerHTML+='<p>${(param1||'').replace(/'/g, "\\'")}</p>';
      el.dispatchEvent(new InputEvent('input',{bubbles:true}));
    }else{
      const desc=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
      const cur=desc.get.call(el);
      desc.set.call(el,cur+'${(param1||'').replace(/'/g, "\\'")}');
      el.dispatchEvent(new Event('input',{bubbles:true}));
    }
    return 'TYPED';
  })()`,

  'key': 'void(0)', // handled separately via Input.dispatchKeyEvent

  'scroll': `(()=>{
    const dir='${(param1||'down').replace(/'/g, "\\'")}';
    const px=${parseInt(param2)||500};
    const y=dir==='up'?-px:px;
    window.scrollBy({top:y,behavior:'smooth'});
    return 'SCROLLED '+dir+' '+px+'px';
  })()`,

  'scroll-to': `(()=>{
    const el=document.querySelector('${(param1||'').replace(/'/g, "\\'")}');
    if(!el)return 'NOT_FOUND';
    el.scrollIntoView({behavior:'smooth',block:'center'});
    return 'SCROLLED_TO: '+el.tagName;
  })()`,

  'focus': `(()=>{
    const el=document.querySelector('${(param1||'').replace(/'/g, "\\'")}');
    if(!el)return 'NOT_FOUND';
    el.focus();
    return 'FOCUSED: '+el.tagName;
  })()`,

  'hover': `(()=>{
    const el=document.querySelector('${(param1||'').replace(/'/g, "\\'")}');
    if(!el)return 'NOT_FOUND';
    el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
    el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    return 'HOVERED: '+el.tagName;
  })()`
};

if (!expressions[action]) {
  console.log('Unknown action:', action);
  process.exit(1);
}

function withTab(tab, cmd, params) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: cmd, params }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 1) {
      if (msg.result?.result?.value) {
        console.log(msg.result.result.value);
      } else if (msg.result?.exceptionDetails) {
        console.log('❌ Error:', msg.result.exceptionDetails.text);
      } else {
        console.log('OK', cmd);
      }
      ws.close();
      process.exit(0);
    }
  };
  ws.onerror = () => { console.log('❌ WebSocket error'); process.exit(1); };
}

function runAction(tab) {
  if (action === 'key') {
    // Keyboard event via Input domain
    const key = param1 || 'Enter';
    const codes = { Enter:'Enter', Tab:'Tab', Escape:'Escape', Space:'Space',
      Backspace:'Backspace', ArrowUp:'ArrowUp', ArrowDown:'ArrowDown',
      ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight' };
    const code = codes[key] || key;
    const keyCode = { Enter:13, Tab:9, Escape:27, Space:32, Backspace:8,
      ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39 }[key] || key.charCodeAt(0);
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id:1, method:'Input.dispatchKeyEvent',
        params:{ type:'keyDown', key, code, keyCode } }));
      ws.send(JSON.stringify({ id:2, method:'Input.dispatchKeyEvent',
        params:{ type:'keyUp', key, code, keyCode } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 2) { console.log('KEY_PRESSED:', key); ws.close(); process.exit(0); }
    };
    ws.onerror = () => { console.log('❌ WS error'); process.exit(1); };
  } else {
    // Runtime.evaluate
    withTab(tab, 'Runtime.evaluate', { expression: expressions[action], returnByValue: true });
  }
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
    runAction(tab);
  });
}).on('error', () => { console.log('❌ No browser on port 9222'); process.exit(1); });
