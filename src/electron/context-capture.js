// Injected into BrowserView pages to intercept right-click and show a context
// capture overlay. The overlay lets users add element info/text/HTML to the
// conversation, take a screenshot of the page, or highlight an element.

(function(){
if(window.__anoclawCtxEnabled) return;
window.__anoclawCtxEnabled=true;
window.__anoclawCtxResult=null;
function rm(){var o=document.getElementById('__anoclaw_ctx_overlay');if(o)o.remove();}
function show(el,x,y){
  rm();
  var tag=el.tagName||'',id=el.id||'';
  var cls=(el.className&&typeof el.className==='string')?el.className.split(' ').slice(0,3).join('.'):'';
  var text=(el.textContent||'').substring(0,200),href=el.href||'',src=el.src||'';
  var label=tag+(id?'#'+id:'')+(cls?'.'+cls:'');
  var preview=text||href||src||'(empty)';
  if(preview.length>100)preview=preview.substring(0,100)+'…';
  var rect=el.getBoundingClientRect();
  var sz=Math.round(rect.width)+' × '+Math.round(rect.height);
  var overlay=document.createElement('div');
  overlay.id='__anoclaw_ctx_overlay';
  overlay.style.cssText='position:fixed;z-index:2147483647;background:#121212;border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:8px 0;min-width:240px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;color:#f4f4f6;';
  var html='<div style="padding:6px 12px;font-size:11px;color:#9c9c9d;word-break:break-all;border-bottom:1px solid rgba(255,255,255,0.06);">'+
    '<span style="color:#ffc533;font-weight:600;">'+label+'</span>'+
    '<span style="margin-left:8px;opacity:0.6;">'+sz+'</span><br>'+
    '<span style="opacity:0.5;font-size:10px;">'+preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span></div>'+
    '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">'+
      '<div class="__ac_act" data-action="add-info" style="padding:6px 14px;cursor:pointer;">📋 Add Element Info</div>'+
      '<div class="__ac_act" data-action="add-text" style="padding:6px 14px;cursor:pointer;">📝 Add Text Content</div>'+
      '<div class="__ac_act" data-action="add-html" style="padding:6px 14px;cursor:pointer;">🔧 Add Outer HTML</div></div>'+
    '<div style="padding:4px 0;">'+
      '<div class="__ac_act" data-action="screenshot" style="padding:6px 14px;cursor:pointer;">📸 Screenshot Page</div>'+
      '<div class="__ac_act" data-action="inspect" style="padding:6px 14px;cursor:pointer;">🔍 Highlight Element</div></div>';
  overlay.innerHTML=html;
  overlay.style.left=Math.min(x,window.innerWidth-260)+'px';
  overlay.style.top=Math.min(y,window.innerHeight-280)+'px';
  var ss=document.createElement('style');
  ss.textContent='.__ac_act:hover{background:rgba(255,255,255,0.06);}';
  overlay.appendChild(ss);
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.__ac_act').forEach(function(item){
    item.addEventListener('click',function(e){
      e.stopPropagation();e.preventDefault();
      var action=item.getAttribute('data-action');
      window.__anoclawCtxResult=JSON.stringify({
        tag:tag,id:id,class:(typeof el.className==='string')?el.className:'',
        text:(el.textContent||'').substring(0,500),html:el.outerHTML?el.outerHTML.substring(0,1000):'',
        href:href,src:src,action:action,url:window.location.href,title:document.title
      });
      rm();
    });
  });
}
document.addEventListener('contextmenu',function(e){
  window.__anoclawCtxResult=null;rm();
  var el=e.target;
  window.__anoclawCtxPick={tag:el.tagName,id:el.id||'',class:(typeof el.className==='string')?el.className:'',text:(el.textContent||'').substring(0,300),href:el.href||'',src:el.src||'',x:e.clientX,y:e.clientY,ts:Date.now()};
  setTimeout(function(){show(el,e.clientX,e.clientY);},10);
},true);
document.addEventListener('click',function(e){if(!e.target.closest('#__anoclaw_ctx_overlay'))rm();},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape')rm();},true);
})();
