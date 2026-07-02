"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // plugins/anoclaw-mcp/frontend/src/main.ts
  var ui = window.anoclaw?.ui;
  if (!ui) throw new Error("anoclaw-ui.js not loaded - check iframe sandbox permissions");
  var T = {
    canvas: "#07080a",
    surface: "#0d0d0d",
    card: "#121212",
    elevated: "#181818",
    raised: "#1e1e1e",
    inputBg: "#101111",
    hairline: "#242728",
    hairlineSoft: "rgba(255,255,255,0.06)",
    hairlineStr: "rgba(255,255,255,0.14)",
    ink: "#f4f4f6",
    body: "#cdcdcd",
    mute: "#9c9c9d",
    ash: "#6a6b6c",
    stone: "#434345",
    accentBlue: "#57c1ff",
    accentBlueBg: "rgba(87,193,255,0.12)",
    accentGreen: "#59d499",
    accentGreenBg: "rgba(89,212,153,0.12)",
    accentYellow: "#ffc533",
    accentYellowBg: "rgba(255,197,51,0.12)",
    accentRed: "#ff6161",
    accentRedBg: "rgba(255,97,97,0.12)",
    accentViolet: "#7b3aed",
    accentVioletBg: "rgba(123,58,237,0.12)",
    white: "#ffffff",
    whiteMuted: "rgba(255,255,255,0.72)",
    rSm: "6px",
    rMd: "8px",
    rLg: "10px",
    rXl: "16px",
    rFull: "9999px",
    fontSans: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontMono: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
    fontFeature: '"calt", "kern", "liga", "ss03"'
  };
  function _el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  function _elHtml(tag, css, html) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    e.innerHTML = html;
    return e;
  }
  function _transition(props) {
    return "transition:" + (props || "all 200ms ease") + ";";
  }
  function _injectStyles() {
    if (document.getElementById("mcp-styles")) return;
    const style = document.createElement("style");
    style.id = "mcp-styles";
    style.textContent = `
    @keyframes mcp-fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes mcp-shimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes mcp-dotPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.4); }
    }
    .mcp-skeleton {
      background: linear-gradient(90deg, ${T.elevated} 25%, ${T.raised} 50%, ${T.elevated} 75%);
      background-size: 200% 100%;
      animation: mcp-shimmer 1.5s infinite;
      border-radius: ${T.rSm};
    }
    .mcp-dot {
      width: 8px; height: 8px; border-radius: 50%;
      display: inline-block; flex-shrink: 0;
    }
    .mcp-dot-connected {
      background: ${T.accentGreen};
      animation: mcp-dotPulse 2s ease infinite;
      box-shadow: 0 0 6px ${T.accentGreenBg};
    }
    .mcp-dot-disconnected {
      background: ${T.stone};
    }
    .mcp-card-hover:hover {
      border-color: ${T.hairlineStr} !important;
      background: ${T.elevated} !important;
    }
    .mcp-card-hover {
      cursor: pointer;
      ${_transition()}
    }
    .mcp-action-btn {
      opacity: 0.5;
      ${_transition("opacity 150ms ease")}
    }
    .mcp-card-hover:hover .mcp-action-btn {
      opacity: 1;
    }
    .mcp-btn-icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      border-radius: ${T.rSm};
      border: 1px solid ${T.hairlineSoft};
      background: ${T.card};
      color: ${T.mute};
      cursor: pointer;
      font-size: 13px;
      ${_transition()}
    }
    .mcp-btn-icon:hover {
      color: ${T.white};
      border-color: ${T.hairlineStr};
      background: ${T.elevated};
    }
    .mcp-btn-icon-danger:hover {
      color: ${T.accentRed};
      border-color: ${T.accentRedBg};
      background: ${T.accentRedBg};
    }
    .mcp-search-input:focus {
      border-color: rgba(87,193,255,0.4) !important;
      outline: none;
      box-shadow: 0 0 0 1px rgba(87,193,255,0.2);
    }
    .mcp-transport-badge {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: ${T.rSm};
      line-height: 1.4;
    }
    .mcp-tab {
      padding: 6px 14px;
      border-radius: ${T.rFull};
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      ${_transition()}
      border: 1px solid transparent;
      color: ${T.mute};
      background: transparent;
      font-family: ${T.fontSans};
      font-feature-settings: ${T.fontFeature};
    }
    .mcp-tab:hover {
      color: ${T.body};
      background: ${T.elevated};
    }
    .mcp-tab-active {
      color: ${T.white} !important;
      background: ${T.elevated} !important;
      border-color: ${T.hairline} !important;
    }
    .mcp-tool-card {
      border: 1px solid ${T.hairlineSoft};
      border-radius: ${T.rMd};
      padding: 12px 16px;
      background: ${T.card};
      ${_transition()}
      cursor: pointer;
    }
    .mcp-tool-card:hover {
      border-color: ${T.hairline};
      background: ${T.elevated};
    }
    .mcp-tool-expanded {
      border-color: ${T.hairline} !important;
      background: ${T.elevated} !important;
    }
  `;
    document.head.appendChild(style);
  }
  function _dotClass(connected) {
    return "mcp-dot " + (connected ? "mcp-dot-connected" : "mcp-dot-disconnected");
  }
  function _skeletonCards(count) {
    const wrap = document.createElement("div");
    for (let i = 0; i < count; i++) {
      const card = _el("div", [
        "border: 1px solid " + T.hairlineSoft + ";",
        "border-radius: " + T.rMd + ";",
        "padding: 16px 20px; margin-bottom: 8px;",
        "background: " + T.card + ";",
        "display: flex; align-items: center; gap: 16px;"
      ].join(""));
      card.appendChild(_el("div", "width:8px;height:8px;border-radius:50%;background:" + T.elevated + ";flex-shrink:0;"));
      const content = _el("div", "flex:1;");
      content.appendChild(_el("div", "class:mcp-skeleton;height:14px;width:50%;margin-bottom:8px;"));
      content.appendChild(_el("div", "class:mcp-skeleton;height:11px;width:70%;"));
      card.appendChild(content);
      const actions = _el("div", "display:flex;gap:6px;flex-shrink:0;");
      actions.appendChild(_el("div", "class:mcp-skeleton;width:28px;height:28px;border-radius:" + T.rSm + ";"));
      actions.appendChild(_el("div", "class:mcp-skeleton;width:28px;height:28px;border-radius:" + T.rSm + ";"));
      card.appendChild(actions);
      wrap.appendChild(card);
    }
    return wrap;
  }
  function _emptyState(title, desc, btnHtml) {
    const wrap = _el("div", [
      "display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "padding:64px 32px;text-align:center;",
      "animation:mcp-fadeIn 300ms ease;"
    ].join(""));
    const iconWrap = _el("div", [
      "width:80px;height:80px;border-radius:" + T.rXl + ";",
      "background:" + T.elevated + ";border:1px solid " + T.hairline + ";",
      "display:flex;align-items:center;justify-content:center;",
      "margin-bottom:24px;"
    ].join(""));
    iconWrap.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="' + T.accentBlue + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"><path d="M4 17V7a2 2 0 0 1 2-2h6l2 2h4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 12h6" opacity="0.5"/><path d="M12 9v6" opacity="0.5"/></svg>';
    wrap.appendChild(iconWrap);
    const titleEl = _el("div", [
      "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
      "font-size:16px;font-weight:500;color:" + T.ink + ";margin-bottom:8px;line-height:1.4;"
    ].join(""), title);
    wrap.appendChild(titleEl);
    const descEl = _el("div", [
      "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
      "font-size:13px;color:" + T.mute + ";line-height:1.5;",
      "max-width:360px;margin-bottom:24px;"
    ].join(""), desc);
    wrap.appendChild(descEl);
    if (btnHtml) {
      const btnWrap = document.createElement("div");
      btnWrap.innerHTML = btnHtml;
      wrap.appendChild(btnWrap);
    }
    return wrap;
  }
  function _transportStyle(transport) {
    const map = {
      stdio: "background:" + T.accentBlueBg + ";color:" + T.accentBlue + ";",
      sse: "background:" + T.accentVioletBg + ";color:" + T.accentViolet + ";",
      http: "background:" + T.accentGreenBg + ";color:" + T.accentGreen + ";"
    };
    return map[transport] || map.stdio;
  }
  function _serverCard(s, isSelected, h) {
    const borderColor = isSelected ? "rgba(87,193,255,0.35)" : T.hairline;
    const bgColor = isSelected ? T.elevated : T.card;
    const card = _el("div", [
      "border:1px solid " + borderColor + ";border-radius:" + T.rMd + ";",
      "padding:16px 20px;background:" + bgColor + ";",
      "display:flex;align-items:center;gap:14px;margin-bottom:8px;",
      _transition(),
      "animation:mcp-fadeIn 200ms ease;",
      isSelected ? "box-shadow:inset 0 0 0 1px rgba(87,193,255,0.12);" : ""
    ].join(""));
    if (!isSelected) {
      card.className = "mcp-card-hover";
      card.addEventListener("click", function() {
        h.onSelect(s.id);
      });
    }
    const dot = _el("span", "", "");
    dot.className = _dotClass(s.connected);
    dot.title = s.connected ? "Connected" : "Disconnected";
    card.appendChild(dot);
    const content = _el("div", "flex:1;min-width:0;");
    const nameRow = _el("div", "display:flex;align-items:center;gap:8px;margin-bottom:4px;");
    nameRow.appendChild(_el("span", [
      "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
      "font-size:14px;font-weight:500;color:" + T.ink + ";",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    ].join(""), s.name));
    nameRow.appendChild(_el("span", "class:mcp-transport-badge;" + _transportStyle(s.transport), s.transport.toUpperCase()));
    content.appendChild(nameRow);
    const infoText = s.connected ? s.toolCount + " tools" + (s.resourceCount > 0 ? " \xB7 " + s.resourceCount + " resources" : "") + (s.serverInfo ? " \xB7 " + s.serverInfo.name + " v" + s.serverInfo.version : "") : "Disconnected";
    content.appendChild(_el("div", [
      "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
      "font-size:12px;color:" + (s.connected ? T.mute : T.stone) + ";",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    ].join(""), infoText));
    card.appendChild(content);
    const actions = _el("div", "display:flex;gap:4px;flex-shrink:0;");
    function mkBtn(icon, title, danger) {
      const btn = _el("button", "class:mcp-btn-icon mcp-action-btn" + (danger ? " mcp-btn-icon-danger" : "") + ";");
      btn.textContent = icon;
      btn.title = title;
      return btn;
    }
    const editBtn = mkBtn("\u270E", "Edit");
    editBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      h.onEdit(s);
    });
    const reBtn = mkBtn("\u21BB", "Reconnect");
    reBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      h.onReconnect(s.id);
    });
    const delBtn = mkBtn("\u2715", "Delete", true);
    delBtn.addEventListener("click", function(e) {
      e.stopPropagation();
      h.onDelete(s.id);
    });
    actions.appendChild(editBtn);
    actions.appendChild(reBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    return card;
  }
  function _toolCard(t, expanded, onToggle) {
    const card = _el("div", "class:mcp-tool-card" + (expanded ? " mcp-tool-expanded" : "") + ";");
    card.addEventListener("click", onToggle);
    const header = _el("div", "display:flex;align-items:center;justify-content:space-between;gap:12px;");
    const nameEl = _el("div", [
      "font-family:" + T.fontMono + ";font-size:13px;font-weight:500;color:" + T.ink + ";",
      "display:flex;align-items:center;gap:8px;"
    ].join(""));
    const chevron = _el("span", [
      "font-size:10px;color:" + T.ash + ";display:inline-block;",
      "transition:transform 150ms ease;",
      expanded ? "transform:rotate(90deg);" : ""
    ].join(""), "\u25B6");
    nameEl.appendChild(chevron);
    nameEl.appendChild(document.createTextNode(t.name));
    header.appendChild(nameEl);
    const schema = t.inputSchema;
    const required = schema && schema.required || [];
    if (required.length > 0) {
      const reqWrap = _el("div", "display:flex;gap:4px;flex-wrap:wrap;");
      for (const r of required.slice(0, 5)) {
        reqWrap.appendChild(_el("span", [
          "font-size:10px;font-weight:500;padding:1px 6px;border-radius:" + T.rSm + ";",
          "background:" + T.accentYellowBg + ";color:" + T.accentYellow + ";",
          "font-family:" + T.fontMono + ";"
        ].join(""), r));
      }
      header.appendChild(reqWrap);
    }
    card.appendChild(header);
    if (t.description) {
      card.appendChild(_el("div", [
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
        "font-size:12px;color:" + T.mute + ";margin-top:6px;line-height:1.4;"
      ].join(""), t.description));
    }
    if (expanded && schema && schema.properties) {
      const sw = _el("div", [
        "margin-top:12px;padding:12px 14px;background:" + T.card + ";",
        "border:1px solid " + T.hairlineSoft + ";border-radius:" + T.rSm + ";",
        "animation:mcp-fadeIn 150ms ease;"
      ].join(""));
      sw.appendChild(_el("div", [
        "font-size:10px;font-weight:600;text-transform:uppercase;",
        "letter-spacing:0.8px;color:" + T.ash + ";margin-bottom:8px;"
      ].join(""), "Input Schema"));
      const props = schema.properties;
      const reqSet = new Set(required);
      for (const key of Object.keys(props)) {
        const val = props[key];
        const row = _el("div", [
          "display:flex;align-items:baseline;gap:8px;padding:4px 0;",
          "border-bottom:1px solid " + T.hairlineSoft + ";"
        ].join(""));
        row.appendChild(_el("code", [
          "font-family:" + T.fontMono + ";font-size:12px;font-weight:500;color:" + T.accentBlue + ";"
        ].join(""), key));
        row.appendChild(_el("span", [
          "font-family:" + T.fontMono + ";font-size:11px;color:" + T.stone + ";"
        ].join(""), val.type || "any"));
        if (reqSet.has(key)) {
          row.appendChild(_el("span", [
            "font-size:9px;font-weight:600;text-transform:uppercase;color:" + T.accentYellow + ";letter-spacing:0.5px;"
          ].join(""), "required"));
        }
        if (val.description) {
          row.appendChild(_el("span", [
            "font-size:11px;color:" + T.ash + ";margin-left:auto;"
          ].join(""), val.description));
        }
        sw.appendChild(row);
      }
      card.appendChild(sw);
    }
    return card;
  }
  function _resourceRow(r) {
    const row = _el("div", [
      "padding:10px 14px;background:" + T.card + ";",
      "border:1px solid " + T.hairlineSoft + ";border-radius:" + T.rMd + ";margin-bottom:6px;",
      _transition()
    ].join(""));
    row.className = "mcp-card-hover";
    row.appendChild(_el("code", [
      "font-family:" + T.fontMono + ";font-size:12px;font-weight:500;color:" + T.accentBlue + ";"
    ].join(""), r.uri));
    if (r.description) {
      row.appendChild(_el("div", "font-size:12px;color:" + T.mute + ";margin-top:4px;line-height:1.4;", r.description));
    }
    if (r.mimeType) {
      row.appendChild(_el("span", [
        "display:inline-block;margin-top:4px;font-size:10px;font-weight:500;",
        "padding:1px 6px;border-radius:" + T.rSm + ";background:" + T.elevated + ";color:" + T.ash + ";",
        "font-family:" + T.fontMono + ";"
      ].join(""), r.mimeType));
    }
    return row;
  }
  function _promptRow(p) {
    const row = _el("div", [
      "padding:10px 14px;background:" + T.card + ";",
      "border:1px solid " + T.hairlineSoft + ";border-radius:" + T.rMd + ";margin-bottom:6px;",
      _transition()
    ].join(""));
    row.className = "mcp-card-hover";
    const nameSpan = _el("span", [
      "font-family:" + T.fontMono + ";font-size:13px;font-weight:500;color:" + T.ink + ";"
    ].join(""), p.name);
    row.appendChild(nameSpan);
    if (p.description) {
      row.appendChild(_el("span", "font-size:12px;color:" + T.mute + ";margin-left:8px;", "\u2014 " + p.description));
    }
    const args = p.arguments || [];
    if (args.length > 0) {
      const argsWrap = _el("div", "display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;");
      for (const a of args) {
        const bg = a.required ? T.accentYellowBg : T.elevated;
        const fg = a.required ? T.accentYellow : T.mute;
        argsWrap.appendChild(_el("span", [
          "font-size:11px;padding:1px 6px;border-radius:" + T.rSm + ";",
          "background:" + bg + ";color:" + fg + ";font-family:" + T.fontMono + ";"
        ].join(""), a.name + (a.required ? "*" : "")));
      }
      row.appendChild(argsWrap);
    }
    return row;
  }
  function _logEntryRow(entry) {
    const levelColors = { error: T.accentRed, warn: T.accentYellow, info: T.accentBlue, debug: T.ash };
    const color = levelColors[entry.level] || T.mute;
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const row = _el("div", [
      "display:flex;align-items:baseline;gap:10px;padding:5px 10px;",
      "font-family:" + T.fontMono + ";font-size:11px;",
      "border-bottom:1px solid " + T.hairlineSoft + ";"
    ].join(""));
    row.appendChild(_el("span", "color:" + T.stone + ";min-width:70px;flex-shrink:0;", time));
    row.appendChild(_el("span", "color:" + color + ";min-width:44px;text-transform:uppercase;font-weight:600;flex-shrink:0;", entry.level));
    row.appendChild(_el("span", "color:" + T.accentBlue + ";min-width:100px;font-weight:500;flex-shrink:0;", entry.server));
    row.appendChild(_el("span", "color:" + T.mute + ";flex:1;word-break:break-word;", entry.message));
    return row;
  }
  var MCPPage = class {
    constructor() {
      __publicField(this, "name", "mcp");
      __publicField(this, "container", document.createElement("div"));
      __publicField(this, "_servers", []);
      __publicField(this, "_selectedId", null);
      __publicField(this, "_listEl");
      __publicField(this, "_detailEl");
      __publicField(this, "_logEl");
      __publicField(this, "_logs", []);
      __publicField(this, "_showLogs", false);
      __publicField(this, "_ws", null);
      __publicField(this, "_wsReconnectTimer", null);
      __publicField(this, "_loading", true);
      __publicField(this, "_expandedTools", /* @__PURE__ */ new Set());
      __publicField(this, "_activeTab", 0);
      _injectStyles();
      this.container.style.cssText = [
        "padding:24px 28px;height:100%;overflow-y:auto;box-sizing:border-box;",
        "background:" + T.canvas + ";color:" + T.body + ";",
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";"
      ].join("");
      const header = _el("div", [
        "display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;",
        "animation:mcp-fadeIn 200ms ease;"
      ].join(""));
      const titleWrap = document.createElement("div");
      titleWrap.appendChild(_el("div", [
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
        "font-size:20px;font-weight:500;color:" + T.ink + ";line-height:1.4;"
      ].join(""), "MCP Servers"));
      titleWrap.appendChild(_el("div", [
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
        "font-size:13px;color:" + T.mute + ";margin-top:2px;"
      ].join(""), "Model Context Protocol \u2014 connect external tools and services"));
      header.appendChild(titleWrap);
      const headerActions = _el("div", "display:flex;align-items:center;gap:12px;");
      const logsBtn = new ui.Button({
        label: "\u25B8 Logs",
        variant: "default",
        size: "sm",
        onClick: () => {
          this._showLogs = !this._showLogs;
          if (this._showLogs) this._fetchLogs();
          else this._logEl.style.display = "none";
        }
      });
      headerActions.appendChild(logsBtn.element);
      const addBtn = new ui.Button({
        label: "+ Connect Server",
        variant: "primary",
        size: "sm",
        onClick: () => this._showForm()
      });
      headerActions.appendChild(addBtn.element);
      header.appendChild(headerActions);
      this.container.appendChild(header);
      this._listEl = document.createElement("div");
      this.container.appendChild(this._listEl);
      this._detailEl = _el("div", "margin-top:20px;");
      this.container.appendChild(this._detailEl);
      this._logEl = _el("div", [
        "margin-top:24px;border-top:1px solid " + T.hairline + ";padding-top:16px;display:none;"
      ].join(""));
      this.container.appendChild(this._logEl);
    }
    onEnter() {
      this._load();
      this._connectWebSocket();
    }
    onExit() {
      this._disconnectWebSocket();
    }
    // --- WebSocket ---
    _connectWebSocket() {
      if (this._ws) return;
      try {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        this._ws = new WebSocket(proto + "//" + location.host + "/ws");
        this._ws.onmessage = (ev) => {
          try {
            this._handleWSMessage(JSON.parse(ev.data));
          } catch {
          }
        };
        this._ws.onclose = () => {
          this._ws = null;
          this._wsReconnectTimer = window.setTimeout(() => this._connectWebSocket(), 3e3);
        };
        this._ws.onerror = () => {
        };
      } catch {
      }
    }
    _disconnectWebSocket() {
      if (this._wsReconnectTimer) {
        clearTimeout(this._wsReconnectTimer);
        this._wsReconnectTimer = null;
      }
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }
    }
    _handleWSMessage(msg) {
      if (msg.type === "mcp:state-change" || msg.type === "mcp:server-deleted" || msg.type === "mcp:server-edited") {
        this._load(true);
        if (this._selectedId) this._selectServer(this._selectedId);
      }
      if (msg.type === "mcp:log" && msg.log) {
        this._addLogEntry(msg.log);
      }
    }
    // --- Logs ---
    _addLogEntry(entry) {
      this._logs.push(entry);
      if (this._logs.length > 200) this._logs.shift();
      this._renderLogs();
    }
    async _fetchLogs() {
      try {
        const resp = await fetch("/api/mcp/logs");
        if (!resp.ok) return;
        const data = await resp.json();
        this._logs = data.logs || [];
        this._renderLogs();
      } catch {
      }
    }
    _renderLogs() {
      if (!this._showLogs) return;
      this._logEl.innerHTML = "";
      const hdr = _el("div", "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;");
      const hTitle = _elHtml("div", [
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";",
        "font-size:14px;font-weight:500;color:" + T.ink + ";",
        "display:flex;align-items:center;gap:8px;"
      ].join(""), '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + T.accentBlue + '" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Connection Logs <span style="font-size:11px;color:' + T.stone + ';font-weight:400;">(' + this._logs.length + ")</span>");
      hdr.appendChild(hTitle);
      const closeBtn = _el("button", "class:mcp-btn-icon;", "\u2715");
      closeBtn.addEventListener("click", () => {
        this._showLogs = false;
        this._logEl.style.display = "none";
      });
      hdr.appendChild(closeBtn);
      this._logEl.appendChild(hdr);
      const list = _el("div", [
        "max-height:300px;overflow-y:auto;background:" + T.surface + ";",
        "border:1px solid " + T.hairline + ";border-radius:" + T.rMd + ";"
      ].join(""));
      if (this._logs.length === 0) {
        list.appendChild(_el("div", "color:" + T.stone + ";padding:24px;text-align:center;font-size:12px;", "No connection logs yet."));
      } else {
        for (const entry of this._logs.slice().reverse()) {
          list.appendChild(_logEntryRow(entry));
        }
      }
      this._logEl.appendChild(list);
      this._logEl.style.display = "block";
    }
    // --- Data ---
    async _load(silent) {
      if (!silent) {
        this._loading = true;
        this._buildList();
      }
      try {
        const resp = await fetch("/api/mcp/servers");
        if (!resp.ok) return;
        const data = await resp.json();
        this._servers = data.servers || [];
        this._loading = false;
        this._buildList();
      } catch (err) {
        this._loading = false;
        if (!silent) {
          new ui.Toast({ text: "Failed to load: " + err.message, type: "error", duration: 4e3 });
          this._buildList();
        }
      }
    }
    // --- Server List ---
    _buildList() {
      this._listEl.innerHTML = "";
      if (this._loading && this._servers.length === 0) {
        this._listEl.appendChild(_skeletonCards(3));
        return;
      }
      if (this._servers.length === 0 && !this._loading) {
        const btn = new ui.Button({ label: "+ Connect Server", variant: "primary", size: "sm", onClick: () => this._showForm() });
        this._listEl.appendChild(_emptyState(
          "No MCP servers connected",
          "Connect to filesystem servers, API gateways, databases, and more to extend your AI agents with external tools.",
          btn.element.outerHTML
        ));
        const emptyBtn = this._listEl.querySelector("button");
        if (emptyBtn) emptyBtn.addEventListener("click", () => this._showForm());
        return;
      }
      const connectedCount = this._servers.filter((s) => s.connected).length;
      const totalTools = this._servers.reduce((sum, s) => sum + (s.connected ? s.toolCount : 0), 0);
      const summary = _el("div", [
        "display:flex;align-items:center;gap:16px;margin-bottom:16px;",
        "padding:10px 16px;background:" + T.surface + ";",
        "border:1px solid " + T.hairlineSoft + ";border-radius:" + T.rMd + ";",
        "animation:mcp-fadeIn 200ms ease;"
      ].join(""));
      const connInd = _el("div", "display:flex;align-items:center;gap:8px;font-size:12px;color:" + T.mute + ";");
      const connDot = _el("span", "");
      connDot.className = _dotClass(connectedCount > 0);
      connInd.appendChild(connDot);
      connInd.appendChild(document.createTextNode(connectedCount + "/" + this._servers.length + " connected"));
      summary.appendChild(connInd);
      summary.appendChild(_el("div", "width:1px;height:16px;background:" + T.hairline + ";"));
      const toolCountEl = _elHtml(
        "div",
        "font-size:12px;color:" + T.mute + ";display:flex;align-items:center;gap:6px;",
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="' + T.ash + '" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> ' + totalTools + " tools available"
      );
      summary.appendChild(toolCountEl);
      this._listEl.appendChild(summary);
      for (const s of this._servers) {
        const card = _serverCard(s, s.id === this._selectedId, {
          onSelect: (id) => this._selectServer(id),
          onEdit: (sv) => this._showForm(sv),
          onReconnect: (id) => this._reconnect(id),
          onDelete: (id) => this._deleteServer(id)
        });
        this._listEl.appendChild(card);
      }
    }
    // --- Detail Panel ---
    async _selectServer(id) {
      this._selectedId = id;
      this._buildList();
      this._detailEl.innerHTML = "";
      const skeleton = _el("div", [
        "padding:20px;border:1px solid " + T.hairlineSoft + ";border-radius:" + T.rMd + ";",
        "background:" + T.card + ";animation:mcp-fadeIn 200ms ease;"
      ].join(""));
      skeleton.appendChild(_el("div", "class:mcp-skeleton;height:18px;width:30%;margin-bottom:12px;"));
      skeleton.appendChild(_el("div", "class:mcp-skeleton;height:12px;width:50%;margin-bottom:16px;"));
      skeleton.appendChild(_el("div", "class:mcp-skeleton;height:100px;width:100%;border-radius:" + T.rMd + ";"));
      this._detailEl.appendChild(skeleton);
      try {
        const resp = await fetch("/api/mcp/servers/" + id);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = await resp.json();
        this._buildDetail(data);
      } catch (err) {
        this._detailEl.innerHTML = "";
        const errEl = _el("div", [
          "padding:16px 20px;border:1px solid " + T.accentRedBg + ";border-radius:" + T.rMd + ";",
          "background:" + T.card + ";color:" + T.accentRed + ";font-size:13px;",
          "display:flex;align-items:center;gap:8px;animation:mcp-fadeIn 200ms ease;"
        ].join(""), "\u26A0 Failed to load server: " + err.message);
        this._detailEl.appendChild(errEl);
      }
    }
    _buildDetail(d) {
      this._detailEl.innerHTML = "";
      this._expandedTools = /* @__PURE__ */ new Set();
      this._activeTab = 0;
      const detailWrap = _el("div", [
        "border:1px solid " + T.hairline + ";border-radius:" + T.rLg + ";",
        "background:" + T.surface + ";overflow:hidden;",
        "animation:mcp-fadeIn 250ms ease;"
      ].join(""));
      const header = _el("div", [
        "padding:20px 24px;border-bottom:1px solid " + T.hairline + ";",
        "display:flex;justify-content:space-between;align-items:flex-start;"
      ].join(""));
      const hLeft = _el("div", "display:flex;flex-direction:column;gap:8px;");
      const nameRow = _el("div", "display:flex;align-items:center;gap:10px;");
      const dot = _el("span", "");
      dot.className = _dotClass(d.connected);
      nameRow.appendChild(dot);
      nameRow.appendChild(_el("span", [
        "font-size:18px;font-weight:500;color:" + T.ink + ";",
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";"
      ].join(""), d.name));
      nameRow.appendChild(_el("span", "class:mcp-transport-badge;" + _transportStyle(d.transport), d.transport.toUpperCase()));
      if (d.serverInfo && d.serverInfo.name) {
        nameRow.appendChild(_el("span", "font-size:11px;color:" + T.stone + ";font-family:" + T.fontMono + ";", d.serverInfo.name + " v" + (d.serverInfo.version || "?")));
      }
      hLeft.appendChild(nameRow);
      const statusLine = _el("div", "font-size:12px;color:" + (d.connected ? T.accentGreen : T.accentRed) + ";display:flex;align-items:center;gap:6px;");
      if (d.connected) {
        statusLine.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + T.accentGreen + ';"></span> Connected \xB7 ' + d.tools.length + " tools \xB7 " + d.resources.length + " resources \xB7 " + d.prompts.length + " prompts";
      } else {
        statusLine.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + T.accentRed + ';"></span> Disconnected \u2014 server is offline';
      }
      hLeft.appendChild(statusLine);
      header.appendChild(hLeft);
      const closeBtn = _el("button", "class:mcp-btn-icon;", "\u2715");
      closeBtn.addEventListener("click", () => {
        this._selectedId = null;
        this._detailEl.innerHTML = "";
        this._buildList();
      });
      header.appendChild(closeBtn);
      detailWrap.appendChild(header);
      const tabContainer = _el("div", [
        "padding:12px 24px 0;display:flex;gap:4px;",
        "border-bottom:1px solid " + T.hairline + ";"
      ].join(""));
      const tabLabels = [
        "Tools (" + d.tools.length + ")",
        "Resources (" + d.resources.length + ")",
        "Prompts (" + d.prompts.length + ")"
      ];
      const tabContent = _el("div", "padding:16px 24px 24px;min-height:80px;");
      const self = this;
      function renderTab(idx) {
        self._activeTab = idx;
        const tabs = tabContainer.querySelectorAll(".mcp-tab");
        tabs.forEach((t, i) => {
          t.className = "mcp-tab" + (i === idx ? " mcp-tab-active" : "");
        });
        tabContent.innerHTML = "";
        tabContent.style.animation = "mcp-fadeIn 150ms ease";
        if (idx === 0) {
          if (d.tools.length === 0) {
            tabContent.appendChild(_el("div", "text-align:center;padding:32px;color:" + T.stone + ";font-size:13px;", "No tools exposed by this server."));
            return;
          }
          const searchWrap = _el("div", "margin-bottom:12px;position:relative;");
          const searchIcon = _elHtml(
            "div",
            "position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;",
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + T.stone + '" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
          );
          searchWrap.appendChild(searchIcon);
          const searchInput = document.createElement("input");
          searchInput.placeholder = "Search tools...";
          searchInput.className = "mcp-search-input";
          searchInput.style.cssText = [
            "width:100%;padding:8px 12px 8px 32px;background:" + T.inputBg + ";",
            "border:1px solid " + T.hairline + ";border-radius:" + T.rMd + ";",
            "color:" + T.ink + ";font-family:" + T.fontSans + ";",
            "font-feature-settings:" + T.fontFeature + ";font-size:13px;",
            "outline:none;box-sizing:border-box;",
            _transition("border-color 200ms ease, box-shadow 200ms ease")
          ].join("");
          searchWrap.appendChild(searchInput);
          tabContent.appendChild(searchWrap);
          const toolListWrap = _el("div", "display:flex;flex-direction:column;gap:6px;");
          const renderTools = (q) => {
            toolListWrap.innerHTML = "";
            const filtered = q ? d.tools.filter((t) => t.name.toLowerCase().indexOf(q.toLowerCase()) !== -1 || (t.description || "").toLowerCase().indexOf(q.toLowerCase()) !== -1) : d.tools;
            if (filtered.length === 0) {
              toolListWrap.appendChild(_el("div", "text-align:center;padding:24px;color:" + T.stone + ";font-size:12px;", 'No tools matching "' + q + '"'));
              return;
            }
            for (const t of filtered) {
              const isExpanded = self._expandedTools.has(t.name);
              const tc = _toolCard(t, isExpanded, () => {
                if (isExpanded) self._expandedTools.delete(t.name);
                else self._expandedTools.add(t.name);
                renderTools(searchInput.value);
              });
              toolListWrap.appendChild(tc);
            }
          };
          renderTools("");
          searchInput.addEventListener("input", () => {
            renderTools(searchInput.value);
          });
          tabContent.appendChild(toolListWrap);
        } else if (idx === 1) {
          if (d.resources.length === 0) {
            tabContent.appendChild(_el("div", "text-align:center;padding:32px;color:" + T.stone + ";font-size:13px;", "No resources exposed by this server."));
            return;
          }
          const list = _el("div", "display:flex;flex-direction:column;gap:6px;");
          for (const r of d.resources) list.appendChild(_resourceRow(r));
          tabContent.appendChild(list);
        } else {
          if (d.prompts.length === 0) {
            tabContent.appendChild(_el("div", "text-align:center;padding:32px;color:" + T.stone + ";font-size:13px;", "No prompts exposed by this server."));
            return;
          }
          const list = _el("div", "display:flex;flex-direction:column;gap:6px;");
          for (const p of d.prompts) list.appendChild(_promptRow(p));
          tabContent.appendChild(list);
        }
      }
      for (let i = 0; i < tabLabels.length; i++) {
        const tab = _el("span", "class:mcp-tab" + (i === 0 ? " mcp-tab-active" : "") + ";", tabLabels[i]);
        tab.addEventListener("click", () => renderTab(i));
        tabContainer.appendChild(tab);
      }
      detailWrap.appendChild(tabContainer);
      detailWrap.appendChild(tabContent);
      this._detailEl.appendChild(detailWrap);
      renderTab(0);
    }
    // --- Form ---
    _showForm(edit) {
      this._detailEl.innerHTML = "";
      const formWrap = _el("div", [
        "border:1px solid " + T.hairline + ";border-radius:" + T.rLg + ";",
        "background:" + T.surface + ";overflow:hidden;",
        "animation:mcp-fadeIn 250ms ease;"
      ].join(""));
      const hdr = _el("div", [
        "padding:20px 24px;border-bottom:1px solid " + T.hairline + ";",
        "display:flex;justify-content:space-between;align-items:center;"
      ].join(""));
      hdr.appendChild(_el("div", [
        "font-size:18px;font-weight:500;color:" + T.ink + ";",
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";"
      ].join(""), edit ? "Edit Server" : "Connect MCP Server"));
      const closeBtn = _el("button", "class:mcp-btn-icon;", "\u2715");
      closeBtn.addEventListener("click", () => {
        this._detailEl.innerHTML = "";
      });
      hdr.appendChild(closeBtn);
      formWrap.appendChild(hdr);
      const body = _el("div", "padding:24px;");
      const row1 = _el("div", "display:flex;gap:16px;margin-bottom:16px;");
      const nameInput = new ui.Input({ placeholder: "my-mcp-server", value: edit ? edit.name : "" });
      const transportSelect = new ui.Select({
        options: [{ value: "stdio", label: "stdio" }, { value: "sse", label: "sse" }, { value: "http", label: "http" }],
        value: edit ? edit.transport : "stdio"
      });
      row1.appendChild(new ui.FormField({ label: "Name", input: nameInput.element }).element);
      row1.appendChild(new ui.FormField({ label: "Transport", input: transportSelect.element }).element);
      body.appendChild(row1);
      const row2 = _el("div", "display:flex;gap:16px;margin-bottom:16px;");
      const commandInput = new ui.Input({ placeholder: "npx -y @modelcontextprotocol/server-filesystem /path", value: edit ? edit.command || "" : "" });
      const urlInput = new ui.Input({ placeholder: "http://localhost:3000", value: edit ? edit.url || "" : "" });
      row2.appendChild(new ui.FormField({ label: "Command (stdio)", input: commandInput.element, help: "Shell command to launch the MCP server process" }).element);
      row2.appendChild(new ui.FormField({ label: "URL (sse/http)", input: urlInput.element, help: "HTTP endpoint for SSE or HTTP transport" }).element);
      body.appendChild(row2);
      const envWrap = _el("div", "margin-bottom:24px;");
      envWrap.appendChild(_el("label", [
        "font-size:13px;font-weight:500;color:" + T.ink + ";display:block;margin-bottom:6px;",
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";"
      ].join(""), "Environment Variables"));
      const envInput = document.createElement("textarea");
      envInput.placeholder = "KEY=value\nOTHER_KEY=other_value";
      envInput.rows = 3;
      envInput.style.cssText = [
        "width:100%;padding:10px 14px;background:" + T.inputBg + ";",
        "border:1px solid " + T.hairline + ";border-radius:" + T.rMd + ";",
        "font-family:" + T.fontMono + ";font-size:12px;resize:vertical;",
        "box-sizing:border-box;color:" + T.ink + ";outline:none;",
        _transition("border-color 200ms ease")
      ].join("");
      if (edit && edit.env) {
        envInput.value = Object.entries(edit.env).map(function(kv) {
          return kv[0] + "=" + kv[1];
        }).join("\n");
      }
      envWrap.appendChild(envInput);
      envWrap.appendChild(_el("div", "font-size:12px;color:" + T.stone + ";margin-top:6px;", "One KEY=value per line. Merged over system env for stdio servers."));
      body.appendChild(envWrap);
      const actions = _el("div", "display:flex;gap:10px;");
      const self = this;
      const saveBtn = new ui.Button({
        label: edit ? "Update & Reconnect" : "Save & Connect",
        variant: "primary",
        size: "sm",
        onClick: async function() {
          const name = nameInput.element.value.trim();
          if (!name) {
            new ui.Toast({ text: "Name is required", type: "warning", duration: 3e3 });
            return;
          }
          const transport = transportSelect.element.value;
          const body2 = { name, transport };
          if (transport === "stdio") body2.command = commandInput.element.value;
          else body2.url = urlInput.element.value;
          const envText = envInput.value.trim();
          if (envText) {
            const env = {};
            const lines = envText.split("\n");
            for (let li = 0; li < lines.length; li++) {
              const trimmed = lines[li].trim();
              if (!trimmed || trimmed.charAt(0) === "#") continue;
              const eqIdx = trimmed.indexOf("=");
              if (eqIdx > 0) env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
            }
            if (Object.keys(env).length > 0) body2.env = env;
          }
          try {
            let resp;
            if (edit) {
              resp = await fetch("/api/mcp/servers/" + edit.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body2) });
            } else {
              resp = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body2) });
            }
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            new ui.Toast({ text: 'Server "' + name + '" ' + (edit ? "updated" : "saved"), type: "success", duration: 3e3 });
            self._detailEl.innerHTML = "";
            self._load();
          } catch (err) {
            new ui.Toast({ text: "Save failed: " + err.message, type: "error", duration: 5e3 });
          }
        }
      });
      actions.appendChild(saveBtn.element);
      actions.appendChild(new ui.Button({ label: "Cancel", variant: "default", size: "sm", onClick: function() {
        self._detailEl.innerHTML = "";
      } }).element);
      body.appendChild(actions);
      formWrap.appendChild(body);
      this._detailEl.appendChild(formWrap);
    }
    // --- Actions ---
    async _deleteServer(id) {
      const overlay = _el("div", [
        "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);",
        "display:flex;align-items:center;justify-content:center;",
        "animation:mcp-fadeIn 150ms ease;backdrop-filter:blur(4px);"
      ].join(""));
      const dialog = _el("div", [
        "background:" + T.surface + ";border:1px solid " + T.hairline + ";",
        "border-radius:" + T.rLg + ";padding:28px;max-width:400px;width:90%;",
        "animation:mcp-fadeIn 200ms ease;"
      ].join(""));
      dialog.appendChild(_el("div", [
        "font-size:16px;font-weight:500;color:" + T.ink + ";",
        "font-family:" + T.fontSans + ";font-feature-settings:" + T.fontFeature + ";margin-bottom:8px;"
      ].join(""), "Delete Server"));
      dialog.appendChild(_el(
        "div",
        "font-size:13px;color:" + T.mute + ";line-height:1.5;margin-bottom:20px;",
        "This MCP server and all its tools will no longer be available to agents. This action cannot be undone."
      ));
      const btnRow = _el("div", "display:flex;gap:10px;justify-content:flex-end;");
      const cancelBtn = new ui.Button({ label: "Cancel", variant: "default", size: "sm", onClick: function() {
        overlay.remove();
      } });
      btnRow.appendChild(cancelBtn.element);
      const self = this;
      const confirmBtn = new ui.Button({
        label: "Delete",
        variant: "danger",
        size: "sm",
        onClick: async function() {
          overlay.remove();
          try {
            await fetch("/api/mcp/servers/" + id, { method: "DELETE" });
            new ui.Toast({ text: "Server deleted", type: "success", duration: 3e3 });
            self._selectedId = null;
            self._detailEl.innerHTML = "";
            self._load();
          } catch (err) {
            new ui.Toast({ text: "Delete failed: " + err.message, type: "error", duration: 5e3 });
          }
        }
      });
      btnRow.appendChild(confirmBtn.element);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      overlay.addEventListener("click", function(e) {
        if (e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
    }
    async _reconnect(id) {
      try {
        const resp = await fetch("/api/mcp/servers/" + id + "/reconnect", { method: "POST" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        new ui.Toast({ text: "Reconnected", type: "success", duration: 3e3 });
        this._load();
        if (this._selectedId === id) this._selectServer(id);
      } catch (err) {
        new ui.Toast({ text: "Reconnect failed: " + err.message, type: "error", duration: 5e3 });
      }
    }
  };
  var page = new MCPPage();
  window._mcpPage = page;
  document.body.appendChild(page.container);
  page.onEnter();
})();
