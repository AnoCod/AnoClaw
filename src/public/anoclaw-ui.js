/* AnoClaw UI Component Library — standalone bundle for plugin iframes.
   Defines window.anoclaw.ui = { Button, Dialog, Toggle, Card, FormField, Input, Select,
   Textarea, Badge, Tooltip, Toast, Tabs, Progress, EmptyState, Spinner, ContextMenu }
   All components use CSS variables from tokens.css for theme consistency. */

(function () {
  'use strict';

  /* ─── Button ─── */
  function Button(config) {
    var btn = document.createElement('button');
    btn.className = 'ui-btn';
    if (config.variant && config.variant !== 'default') btn.classList.add('ui-btn-' + config.variant);
    if (config.size && config.size !== 'md') btn.classList.add('ui-btn-' + config.size);
    if (config.disabled) btn.disabled = true;
    btn.textContent = config.label;
    if (config.title) btn.title = config.title;
    if (config.onClick) btn.addEventListener('click', config.onClick);
    this.element = btn;
    Object.defineProperty(this, 'disabled', {
      get: function () { return btn.disabled; },
      set: function (v) { btn.disabled = v; }
    });
    Object.defineProperty(this, 'label', {
      get: function () { return btn.textContent; },
      set: function (v) { btn.textContent = v; }
    });
  }

  /* ─── Dialog ─── */
  function Dialog(config) {
    var self = this;
    var onClose = config.onClose;
    var overlay = document.createElement('div');
    overlay.className = 'ui-dialog-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'ui-dialog';
    if (config.width) dialog.style.width = config.width;
    var header = document.createElement('div');
    header.className = 'ui-dialog-header';
    var title = document.createElement('h2');
    title.className = 'ui-dialog-title';
    title.textContent = config.title;
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ui-dialog-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { self.close(); });
    header.appendChild(title);
    header.appendChild(closeBtn);
    var body = document.createElement('div');
    body.className = 'ui-dialog-body';
    if (typeof config.body === 'string') body.textContent = config.body;
    else body.appendChild(config.body);
    dialog.appendChild(header);
    dialog.appendChild(body);
    if (config.footer) {
      var footer = document.createElement('div');
      footer.className = 'ui-dialog-footer';
      footer.appendChild(config.footer);
      dialog.appendChild(footer);
    }
    overlay.appendChild(dialog);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) self.close();
    });
    var escHandler = function (e) {
      if (e.key === 'Escape') self.close();
    };
    this.show = function () {
      document.body.appendChild(overlay);
      document.addEventListener('keydown', escHandler);
    };
    this.close = function () {
      if (overlay.parentElement) overlay.remove();
      document.removeEventListener('keydown', escHandler);
      if (onClose) onClose();
    };
  }

  /* ─── Toggle ─── */
  function Toggle(config) {
    config = config || {};
    var checked = config.checked || false;
    var onChange = config.onChange;
    var el = document.createElement('div');
    el.className = 'ui-toggle';
    if (checked) el.classList.add('on');
    var thumb = document.createElement('div');
    thumb.className = 'ui-toggle-thumb';
    el.appendChild(thumb);
    el.addEventListener('click', function () {
      checked = !checked;
      el.classList.toggle('on', checked);
      if (onChange) onChange(checked);
    });
    this.element = el;
    Object.defineProperty(this, 'checked', {
      get: function () { return checked; },
      set: function (v) { checked = v; el.classList.toggle('on', v); }
    });
  }

  /* ─── Card ─── */
  function Card(config) {
    var el = document.createElement('div');
    el.className = 'ui-card';
    if (config.interactive) el.classList.add('ui-card-interactive');
    if (config.disabled) el.classList.add('ui-card-disabled');
    if (typeof config.content === 'string') el.textContent = config.content;
    else el.appendChild(config.content);
    if (config.onClick) el.addEventListener('click', config.onClick);
    this.element = el;
  }

  /* ─── FormField ─── */
  function FormField(config) {
    var field = document.createElement('div');
    field.className = 'ui-form-field';
    var label = document.createElement('label');
    label.textContent = config.label;
    field.appendChild(label);
    field.appendChild(config.input);
    if (config.help) {
      var help = document.createElement('div');
      help.style.cssText = 'font-size:11px;color:var(--color-text-quaternary);margin-top:4px;';
      help.textContent = config.help;
      field.appendChild(help);
    }
    this.element = field;
  }

  /* ─── Input ─── */
  function Input(config) {
    config = config || {};
    var input = document.createElement('input');
    input.type = config.type || 'text';
    input.className = 'ui-input';
    if (config.placeholder) input.placeholder = config.placeholder;
    if (config.value) input.value = config.value;
    if (config.disabled) input.disabled = true;
    if (config.onChange) input.addEventListener('input', function () { config.onChange(input.value); });
    this.element = input;
    Object.defineProperty(this, 'value', {
      get: function () { return input.value; },
      set: function (v) { input.value = v; }
    });
    Object.defineProperty(this, 'disabled', {
      get: function () { return input.disabled; },
      set: function (v) { input.disabled = v; }
    });
  }

  /* ─── Select ─── */
  function Select(config) {
    config = config || {};
    var sel = document.createElement('select');
    sel.className = 'ui-select';
    (config.options || []).forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    if (config.value) sel.value = config.value;
    if (config.onChange) sel.addEventListener('change', function () { config.onChange(sel.value); });
    this.element = sel;
    Object.defineProperty(this, 'value', {
      get: function () { return sel.value; },
      set: function (v) { sel.value = v; }
    });
  }

  /* ─── Textarea ─── */
  function Textarea(config) {
    config = config || {};
    var ta = document.createElement('textarea');
    ta.className = 'ui-textarea';
    ta.rows = config.rows || 3;
    if (config.placeholder) ta.placeholder = config.placeholder;
    if (config.value) ta.value = config.value;
    if (config.onChange) ta.addEventListener('input', function () { config.onChange(ta.value); });
    this.element = ta;
    Object.defineProperty(this, 'value', {
      get: function () { return ta.value; },
      set: function (v) { ta.value = v; }
    });
  }

  /* ─── Badge ─── */
  function Badge(config) {
    var el = document.createElement('span');
    el.className = 'ui-badge';
    if (config.variant && config.variant !== 'default') el.classList.add('ui-badge-' + config.variant);
    el.textContent = config.text;
    this.element = el;
  }

  /* ─── Tooltip ─── */
  function Tooltip(config) {
    var self = this;
    var tip = document.createElement('div');
    tip.className = 'ui-tooltip';
    tip.textContent = config.text;
    tip.style.visibility = 'hidden';
    document.body.appendChild(tip);
    var anchor = config.anchor;
    var pos = config.position || 'top';
    function show() {
      var rect = anchor.getBoundingClientRect();
      tip.style.visibility = 'visible';
      if (pos === 'top') { tip.style.left = rect.left + rect.width / 2 - tip.offsetWidth / 2 + 'px'; tip.style.top = rect.top - tip.offsetHeight - 4 + 'px'; }
      else if (pos === 'bottom') { tip.style.left = rect.left + rect.width / 2 - tip.offsetWidth / 2 + 'px'; tip.style.top = rect.bottom + 4 + 'px'; }
      else if (pos === 'left') { tip.style.left = rect.left - tip.offsetWidth - 4 + 'px'; tip.style.top = rect.top + rect.height / 2 - tip.offsetHeight / 2 + 'px'; }
      else { tip.style.left = rect.right + 4 + 'px'; tip.style.top = rect.top + rect.height / 2 - tip.offsetHeight / 2 + 'px'; }
    }
    function hide() { tip.style.visibility = 'hidden'; }
    anchor.addEventListener('mouseenter', show);
    anchor.addEventListener('mouseleave', hide);
    this.destroy = function () {
      anchor.removeEventListener('mouseenter', show);
      anchor.removeEventListener('mouseleave', hide);
      if (tip.parentElement) tip.remove();
    };
  }

  /* ─── Toast ─── */
  function Toast(config) {
    var el = document.createElement('div');
    el.className = 'ui-toast';
    if (config.type) el.classList.add('ui-toast-' + config.type);
    el.textContent = config.text;
    if (config.dismissible !== false) {
      var close = document.createElement('button');
      close.className = 'ui-toast-close';
      close.innerHTML = '&times;';
      close.addEventListener('click', function () {
        el.classList.add('ui-toast-hiding');
        setTimeout(function () { if (el.parentElement) el.remove(); }, 200);
      });
      el.appendChild(close);
    }
    if (config.duration && config.duration > 0) {
      setTimeout(function () {
        el.classList.add('ui-toast-hiding');
        setTimeout(function () { if (el.parentElement) el.remove(); }, 200);
      }, config.duration);
    }
    this.element = el;
  }

  /* ─── Tabs ─── */
  function Tabs(config) {
    var self = this;
    var activeIndex = config.activeIndex || 0;
    var onChange = config.onChange;
    var container = document.createElement('div');
    container.className = 'ui-tabs';
    var tabBar = document.createElement('div');
    tabBar.className = 'ui-tabs-bar';
    var panelArea = document.createElement('div');
    panelArea.className = 'ui-tabs-panels';
    config.tabs.forEach(function (tab, i) {
      var btn = document.createElement('button');
      btn.className = 'ui-tabs-btn';
      if (i === activeIndex) btn.classList.add('active');
      btn.textContent = tab.label;
      btn.addEventListener('click', function () {
        self.activeIndex = i;
      });
      tabBar.appendChild(btn);
      var panel = document.createElement('div');
      panel.className = 'ui-tabs-panel';
      panel.appendChild(tab.content);
      panelArea.appendChild(panel);
    });
    container.appendChild(tabBar);
    container.appendChild(panelArea);
    this.element = container;
    Object.defineProperty(this, 'activeIndex', {
      get: function () { return activeIndex; },
      set: function (v) {
        activeIndex = v;
        var btns = tabBar.querySelectorAll('.ui-tabs-btn');
        var panels = panelArea.querySelectorAll('.ui-tabs-panel');
        btns.forEach(function (b, i) { b.classList.toggle('active', i === v); });
        panels.forEach(function (p, i) { p.classList.toggle('active', i === v); });
        if (onChange) onChange(v);
      }
    });
    var panels = panelArea.querySelectorAll('.ui-tabs-panel');
    panels.forEach(function (p, i) { p.classList.toggle('active', i === activeIndex); });
  }

  /* ─── Progress ─── */
  function Progress(config) {
    config = config || {};
    var outer = document.createElement('div');
    outer.className = 'ui-progress';
    var bar = document.createElement('div');
    bar.className = 'ui-progress-bar';
    if (config.variant) bar.classList.add('ui-progress-' + config.variant);
    bar.style.width = (config.value || 0) + '%';
    outer.appendChild(bar);
    this.element = outer;
    Object.defineProperty(this, 'value', {
      get: function () { return parseFloat(bar.style.width) || 0; },
      set: function (v) { bar.style.width = v + '%'; }
    });
  }

  /* ─── EmptyState ─── */
  function EmptyState(config) {
    var el = document.createElement('div');
    el.className = 'ui-empty';
    var icon = document.createElement('div');
    icon.className = 'ui-empty-icon';
    icon.innerHTML = config.icon || '';
    var title = document.createElement('div');
    title.className = 'ui-empty-title';
    title.textContent = config.title || '';
    var desc = document.createElement('div');
    desc.className = 'ui-empty-desc';
    desc.textContent = config.description || '';
    el.appendChild(icon);
    el.appendChild(title);
    el.appendChild(desc);
    if (config.action) {
      var actionArea = document.createElement('div');
      actionArea.className = 'ui-empty-action';
      actionArea.appendChild(config.action.element);
      el.appendChild(actionArea);
    }
    this.element = el;
  }

  /* ─── Spinner ─── */
  function Spinner(config) {
    config = config || {};
    var el = document.createElement('div');
    el.className = 'ui-spinner';
    if (config.size && config.size !== 'md') el.classList.add('ui-spinner-' + config.size);
    this.element = el;
  }

  /* ─── ContextMenu ─── */
  function ContextMenu(config) {
    var self = this;
    var menu = document.createElement('div');
    menu.className = 'ui-context-menu';
    (config.items || []).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'ui-context-menu-item';
      if (item.disabled) row.classList.add('disabled');
      row.textContent = item.label;
      if (!item.disabled) {
        row.addEventListener('click', function () {
          if (item.onClick) item.onClick();
          self.close();
        });
      }
      menu.appendChild(row);
    });
    this.element = menu;
    this.show = function (x, y) {
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      document.body.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('click', self.close);
      }, 0);
    };
    this.close = function () {
      if (menu.parentElement) menu.remove();
      document.removeEventListener('click', self.close);
    };
  }

  /* ─── ToolCard (default) ─── */
  function ToolCard(state) {
    var self = this;
    this._fullResult = state.result || '';
    this._expanded = state.status === 'running';
    this._bodyEl = null;
    this._showMoreBtn = null;

    var meta = {
      Read: { verb: 'read' }, Write: { verb: 'wrote' }, Edit: { verb: 'edited' },
      Grep: { verb: 'searched' }, Glob: { verb: 'found' }, Bash: { verb: 'ran' },
      WebSearch: { verb: 'searched' }, WebFetch: { verb: 'fetched' }
    };
    var m = meta[state.toolName] || { verb: state.toolName.toLowerCase().replace(/([A-Z])/g, ' $1').trim() };
    var subj = (state.toolInput && (state.toolInput.file_path || state.toolInput.pattern || state.toolInput.query || '')) || '';
    if (subj) subj = subj.replace(/\\/g, '/').split('/').pop() || subj.slice(0, 40);
    var action = subj ? m.verb + ' ' + subj : m.verb;

    var wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard';

    var indicator = document.createElement('div');
    indicator.className = 'ui-toolcard-indicator';

    var dot = document.createElement('span');
    dot.className = 'ui-toolcard-dot ' + state.status;
    indicator.appendChild(dot);

    var badge = document.createElement('span');
    badge.className = 'ui-toolcard-name';
    badge.textContent = state.toolName.toUpperCase();
    indicator.appendChild(badge);

    var sep = document.createElement('span');
    sep.className = 'ui-toolcard-sep';
    sep.textContent = '·';
    indicator.appendChild(sep);

    var actionEl = document.createElement('span');
    actionEl.className = 'ui-toolcard-action';
    actionEl.textContent = action;
    indicator.appendChild(actionEl);

    if (typeof state.durationMs === 'number' && state.durationMs > 0) {
      var dur = document.createElement('span');
      dur.className = 'ui-toolcard-dur';
      dur.textContent = '· ' + (state.durationMs >= 1000 ? (state.durationMs / 1000).toFixed(1) + 's' : state.durationMs + 'ms');
      indicator.appendChild(dur);
    }

    var hasBody = this._fullResult && this._fullResult.length > 0;
    if (hasBody) {
      indicator.classList.add('clickable');
      indicator.addEventListener('click', function () { self._toggle(); });
    }
    wrapper.appendChild(indicator);

    if (hasBody) {
      var isLong = this._fullResult.length > 200 || this._fullResult.split('\n').length > 5;
      var body = document.createElement('pre');
      body.className = 'ui-toolcard-body';
      body.textContent = isLong ? this._fullResult.slice(0, 400) : this._fullResult;
      if (isLong && !this._expanded) { body.style.maxHeight = '60px'; body.style.overflow = 'hidden'; }
      body.hidden = !this._expanded;
      this._bodyEl = body;
      wrapper.appendChild(body);

      if (isLong) {
        var moreBtn = document.createElement('button');
        moreBtn.className = 'ui-toolcard-more';
        moreBtn.textContent = 'Show more';
        moreBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          self._toggle();
          moreBtn.textContent = self._expanded ? 'Show less' : 'Show more';
        });
        this._showMoreBtn = moreBtn;
        wrapper.appendChild(moreBtn);
      }
    }

    this.element = wrapper;
    this._injectKeyframes();
  }

  ToolCard.prototype._toggle = function () {
    this._expanded = !this._expanded;
    if (this._bodyEl) {
      if (this._expanded) { this._bodyEl.textContent = this._fullResult; this._bodyEl.hidden = false; }
      else { this._bodyEl.hidden = true; }
    }
    if (this._showMoreBtn) this._showMoreBtn.textContent = this._expanded ? 'Show less' : 'Show more';
  };

  ToolCard.prototype._injectKeyframes = function () {
    if (document.getElementById('tc-keyframes')) return;
    var s = document.createElement('style');
    s.id = 'tc-keyframes';
    s.textContent = '@keyframes tc-pulse{0%,100%{opacity:.3}50%{opacity:1}}';
    document.head.appendChild(s);
  };

  /* ─── ToolCardResult ─── */
  function ToolCardResult(state) { ToolCard.call(this, state); }
  ToolCardResult.prototype = Object.create(ToolCard.prototype);

  /* ─── ToolCardDiff ─── */
  function ToolCardDiff(state) { ToolCard.call(this, state); }
  ToolCardDiff.prototype = Object.create(ToolCard.prototype);

  /* ─── ToolCardProgress ─── */
  function ToolCardProgress(state) { ToolCard.call(this, state); }
  ToolCardProgress.prototype = Object.create(ToolCard.prototype);

  /* ─── ToolCardError ─── */
  function ToolCardError(state) { ToolCard.call(this, state); }
  ToolCardError.prototype = Object.create(ToolCard.prototype);

  /* ─── TodoCard ─── */
  function TodoCard(config) {
    var card = document.createElement('div');
    card.className = 'ui-todocard';
    var header = document.createElement('div'), dot = document.createElement('span'), label = document.createElement('span');
    header.className = 'ui-todocard-header'; dot.className = 'ui-todocard-dot'; label.className = 'ui-todocard-label';
    var done = 0, active = 0, pend = 0;
    (config.todos || []).forEach(function(t) { if (t.status === 'completed') done++; else if (t.status === 'in_progress') active++; else pend++; });
    var parts = []; if (active) parts.push(active + ' active'); if (done) parts.push(done + ' done'); if (pend) parts.push(pend + ' pending');
    label.textContent = 'TODO' + (parts.length ? ' · ' + parts.join(' · ') : '');
    header.appendChild(dot); header.appendChild(label); card.appendChild(header);
    var list = document.createElement('div'); list.className = 'ui-todocard-list';
    (config.todos || []).forEach(function(t) {
      var row = document.createElement('div'), icon = document.createElement('span'), text = document.createElement('span');
      row.className = 'ui-todocard-row'; icon.className = 'ui-todocard-icon ' + t.status;
      var icons = { pending: '○', in_progress: '◉', completed: '●' };
      icon.textContent = icons[t.status] || '○'; row.appendChild(icon);
      text.className = 'ui-todocard-text ' + t.status; text.textContent = t.activeForm || t.content; row.appendChild(text);
      list.appendChild(row);
    });
    card.appendChild(list); this.element = card;
  }

  /* ─── StatusCard ─── */
  function StatusCard(content) {
    var el = document.createElement('div'); el.className = 'ui-statuscard';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width','16'); svg.setAttribute('height','16'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.classList.add('ui-statuscard-spinner');
    var bg = document.createElementNS('http://www.w3.org/2000/svg','circle');
    bg.setAttribute('cx','12'); bg.setAttribute('cy','12'); bg.setAttribute('r','10'); bg.setAttribute('stroke','var(--color-hairline)'); bg.setAttribute('stroke-width','2'); svg.appendChild(bg);
    var arc = document.createElementNS('http://www.w3.org/2000/svg','circle');
    arc.setAttribute('cx','12'); arc.setAttribute('cy','12'); arc.setAttribute('r','10'); arc.setAttribute('stroke','var(--color-text-secondary)'); arc.setAttribute('stroke-width','2');
    arc.setAttribute('stroke-dasharray','31.4 31.4'); arc.setAttribute('stroke-dashoffset','23.55'); arc.setAttribute('stroke-linecap','round'); arc.setAttribute('fill','none');
    arc.classList.add('ui-statuscard-arc'); svg.appendChild(arc); el.appendChild(svg);
    var t = document.createElement('span'); t.className = 'ui-statuscard-text'; t.textContent = content; el.appendChild(t);
    this.element = el; this._textEl = t; this._injectStatusStyles();
  }
  StatusCard.prototype._injectStatusStyles = function() {
    if (document.getElementById('scc-styles')) return; var s = document.createElement('style'); s.id = 'scc-styles';
    s.textContent = '.ui-statuscard{display:flex;align-items:center;gap:8px;padding:6px 14px;margin:2px 0;font-size:12px;color:var(--color-text-secondary)}.ui-statuscard-spinner{flex-shrink:0;animation:scc-spin 1.2s linear infinite}.ui-statuscard-arc{stroke:var(--color-text-secondary)}.ui-statuscard-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@keyframes scc-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  };
  Object.defineProperty(StatusCard.prototype, 'text', { set: function(v) { this._textEl.textContent = v; } });

  /* ─── SystemCard ─── */
  function SystemCard(config) {
    var wrapper = document.createElement('div'); wrapper.className = 'ui-systemcard';
    var msg = document.createElement('span'); msg.className = 'ui-systemcard-text ' + (config.level || 'info');
    msg.textContent = config.content; wrapper.appendChild(msg); this.element = wrapper;
  }

  /* ─── Namespace ─── */
  window.anoclaw = window.anoclaw || {};
  window.anoclaw.ui = {
    Button: Button, Dialog: Dialog, Toggle: Toggle, Card: Card, FormField: FormField,
    Input: Input, Select: Select, Textarea: Textarea, Badge: Badge, Tooltip: Tooltip,
    Toast: Toast, Tabs: Tabs, Progress: Progress, EmptyState: EmptyState, Spinner: Spinner,
    ContextMenu: ContextMenu,
    ToolCard: ToolCard, ToolCardResult: ToolCardResult, ToolCardDiff: ToolCardDiff,
    ToolCardProgress: ToolCardProgress, ToolCardError: ToolCardError,
    TodoCard: TodoCard, StatusCard: StatusCard, SystemCard: SystemCard
  };

  // If running inside an iframe (plugin page), delegate slot operations to parent window
  if (window.parent !== window && window.parent.anoclaw && window.parent.anoclaw.ui) {
    var parentUi = window.parent.anoclaw.ui;
    window.anoclaw.ui.mount = function(slot, el, position, replace) {
      var opts = (position && typeof position === 'object') ? position : { position: position, replace: replace };
      opts.pluginName = opts.pluginName || window.__ANOCLAW_PLUGIN_NAME__ || el.dataset.pluginName;
      return parentUi.mount(slot, el, opts, opts.replace);
    };
    window.anoclaw.ui.unmount = function(slot, el) {
      return parentUi.unmount(slot, el);
    };
    window.anoclaw.ui.unmountAll = function(slot) {
      return parentUi.unmountAll(slot, window.__ANOCLAW_PLUGIN_NAME__);
    };
    window.anoclaw.ui.registerToolCard = function(name, comp) {
      return parentUi.registerToolCard(name, comp);
    };
  }
})();
