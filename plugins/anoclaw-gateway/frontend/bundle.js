"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // plugins/anoclaw-gateway/frontend/src/main.ts
  var PLATFORMS = [
    { id: "telegram", name: "Telegram", icon: "telegram", color: "#57c1ff", colorSoft: "rgba(87,193,255,0.15)", fields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF...", required: true, help: "Get from @BotFather on Telegram" },
      { key: "allowedUserIds", label: "Allowed User IDs", type: "text", placeholder: "123,456", required: false, help: "Comma-separated user IDs. Leave empty for all." }
    ], setupSteps: [
      "1. Open Telegram and search for @BotFather",
      "2. Send /newbot and follow the prompts to create your bot",
      "3. Copy the bot token from BotFather",
      "4. Optionally, start a chat with your bot and send /start",
      "5. Paste the bot token above and click Connect"
    ] },
    { id: "wechat", name: "WeChat", icon: "wechat", color: "#59d499", colorSoft: "rgba(89,212,153,0.15)", fields: [
      { key: "token", label: "Token", type: "password", placeholder: "iLink Bot Token", required: true, help: "Your WeChat iLink Bot API token" },
      { key: "accountId", label: "Account ID", type: "text", placeholder: "wechat account id", required: true, help: "Your WeChat account ID" }
    ], setupSteps: [
      "1. Register at the WeChat iLink Bot API portal",
      "2. Create a new bot application",
      "3. Get your API token from the dashboard",
      "4. Copy your account ID from settings",
      "5. Enter credentials above and click Connect"
    ] },
    { id: "feishu", name: "Feishu", icon: "feishu", color: "#ffc533", colorSoft: "rgba(255,197,51,0.15)", fields: [
      { key: "appId", label: "App ID", type: "text", placeholder: "cli_...", required: true, help: "Your Feishu app ID (starts with cli_)" },
      { key: "appSecret", label: "App Secret", type: "password", placeholder: "", required: true, help: "Your Feishu app secret key" }
    ], setupSteps: [
      "1. Go to the Feishu Open Platform (open.feishu.cn)",
      "2. Create a new application",
      "3. Copy the App ID from app credentials",
      "4. Copy the App Secret from app credentials",
      "5. Enable bot capabilities in the app settings",
      "6. Enter credentials above and click Connect"
    ] }
  ];
  var ICONS = {
    telegram: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`,
    wechat: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z" fill="currentColor" stroke="none"/><path d="M15 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z" fill="currentColor" stroke="none"/><path d="M12 22c-4.97 0-9-2.69-9-6 0-2.22 1.47-4.18 3.63-5.37L9 9"/><path d="M12 22c4.97 0 9-2.69 9-6 0-1.47-.68-2.81-1.75-3.83"/><circle cx="12" cy="12" r="10"/></svg>`,
    feishu: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
    send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    connect: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>`,
    disconnect: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`,
    trash: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    inbox: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
    health: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    template: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
    retry: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    wizard: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    detail: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    webhook: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
  };
  function platformIcon(id) {
    return ICONS[id] || "";
  }
  var GatewayPage = class {
    constructor() {
      __publicField(this, "name", "gateway");
      __publicField(this, "container");
      __publicField(this, "_connections", []);
      __publicField(this, "_inbox", []);
      __publicField(this, "_health", null);
      __publicField(this, "_templates", []);
      __publicField(this, "_retryQueue", []);
      __publicField(this, "_ws", null);
      __publicField(this, "_wsReconnectTimer", null);
      __publicField(this, "_wsConnected", false);
      __publicField(this, "_activeTab", "inbox");
      __publicField(this, "_searchQuery", "");
      __publicField(this, "_searchPlatform", "");
      __publicField(this, "_searchResults", null);
      __publicField(this, "_selectedMessage", null);
      __publicField(this, "_wizardConnectionId", null);
      __publicField(this, "_wizardStep", 0);
      this.container = document.createElement("div");
      this.container.innerHTML = `<div class="gw-inner"></div>`;
      this._injectStyles();
    }
    _injectStyles() {
      if (document.getElementById("gw-styles")) return;
      const style = document.createElement("style");
      style.id = "gw-styles";
      style.textContent = `
      :root {
        --gw-canvas: #07080a;
        --gw-surface: #0d0d0d;
        --gw-surface-elevated: #101111;
        --gw-surface-card: #121212;
        --gw-hairline: #242728;
        --gw-hairline-soft: rgba(255,255,255,0.08);
        --gw-hairline-strong: rgba(255,255,255,0.16);
        --gw-text-primary: #f4f4f6;
        --gw-text-secondary: rgba(255,255,255,0.72);
        --gw-text-tertiary: #9c9c9d;
        --gw-text-quaternary: #6a6b6c;
        --gw-accent-blue: #57c1ff;
        --gw-accent-blue-soft: rgba(87,193,255,0.15);
        --gw-accent-green: #59d499;
        --gw-accent-green-soft: rgba(89,212,153,0.15);
        --gw-accent-red: #ff6161;
        --gw-accent-red-soft: rgba(255,97,97,0.15);
        --gw-accent-yellow: #ffc533;
        --gw-accent-yellow-soft: rgba(255,197,51,0.15);
        --gw-radius-sm: 6px;
        --gw-radius-md: 8px;
        --gw-radius-lg: 10px;
        --gw-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .gw-inner {
        font-family: var(--gw-font);
        background: var(--gw-canvas);
        color: var(--gw-text-primary);
        padding: 24px;
        min-height: 100vh;
        -webkit-font-smoothing: antialiased;
      }

      /* \u2500\u2500 Header \u2500\u2500 */
      .gw-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 24px; padding-bottom: 16px;
        border-bottom: 1px solid var(--gw-hairline);
      }
      .gw-header-title {
        font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
        color: var(--gw-text-secondary); font-weight: 500;
      }
      .gw-header-status {
        display: flex; align-items: center; gap: 8px; font-size: 10px;
        color: var(--gw-text-tertiary);
      }
      .gw-ws-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--gw-text-quaternary);
        transition: background 0.3s;
      }
      .gw-ws-dot.connected {
        background: var(--gw-accent-green);
        box-shadow: 0 0 6px var(--gw-accent-green-soft);
        animation: gw-pulse 2s ease-in-out infinite;
      }
      @keyframes gw-pulse { 0%,100% { opacity:0.6 } 50% { opacity:1 } }

      /* \u2500\u2500 Message Counter \u2500\u2500 */
      .gw-msg-counter {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 8px; border-radius: 10px;
        background: var(--gw-accent-blue-soft); color: var(--gw-accent-blue);
        font-size: 10px; font-weight: 600; letter-spacing: 0.3px;
        transition: transform 0.2s;
      }
      .gw-msg-counter.bump { animation: gw-counter-bump 0.3s ease-out; }
      @keyframes gw-counter-bump { 0% { transform: scale(1) } 50% { transform: scale(1.15) } 100% { transform: scale(1) } }

      /* \u2500\u2500 Platform Cards \u2500\u2500 */
      .gw-platforms-label {
        font-size: 11px; color: var(--gw-text-quaternary); letter-spacing: 0.5px;
        margin-bottom: 8px;
      }
      .gw-platforms-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 8px; margin-bottom: 24px;
      }
      .gw-platform-card {
        padding: 16px; background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); cursor: pointer; text-align: center;
        transition: border-color 0.15s, background 0.15s, transform 0.1s;
      }
      .gw-platform-card:hover {
        border-color: var(--gw-hairline-strong); background: var(--gw-surface-elevated);
        transform: translateY(-1px);
      }
      .gw-platform-icon {
        width: 40px; height: 40px; border-radius: var(--gw-radius-md);
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 10px; transition: background 0.15s;
      }
      .gw-platform-card:hover .gw-platform-icon { background: var(--gw-surface-card); }
      .gw-platform-name { font-size: 12px; font-weight: 500; color: var(--gw-text-secondary); }
      .gw-platform-desc { font-size: 9px; color: var(--gw-text-quaternary); margin-top: 2px; letter-spacing: 0.3px; }

      /* \u2500\u2500 Tabs \u2500\u2500 */
      .gw-tabs {
        display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--gw-hairline);
      }
      .gw-tab {
        padding: 8px 16px; font-size: 11px; font-weight: 500; letter-spacing: 0.5px;
        color: var(--gw-text-quaternary); background: none; border: none; border-bottom: 2px solid transparent;
        cursor: pointer; transition: color 0.15s, border-color 0.15s; text-transform: uppercase;
        font-family: var(--gw-font); display: flex; align-items: center; gap: 5px;
      }
      .gw-tab:hover { color: var(--gw-text-tertiary); }
      .gw-tab.active { color: var(--gw-text-primary); border-bottom-color: var(--gw-accent-blue); }
      .gw-tab-badge {
        padding: 1px 5px; border-radius: 8px; font-size: 8px; font-weight: 700;
        background: var(--gw-accent-red-soft); color: var(--gw-accent-red);
        min-width: 14px; text-align: center;
      }

      /* \u2500\u2500 Connection Cards \u2500\u2500 */
      .gw-conn-card {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; margin-bottom: 6px; background: var(--gw-surface);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-md);
        transition: border-color 0.15s;
      }
      .gw-conn-card:hover { border-color: var(--gw-hairline-strong); }
      .gw-conn-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
      .gw-conn-status {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        transition: background 0.3s;
      }
      .gw-conn-status.connected {
        background: var(--gw-accent-green);
        box-shadow: 0 0 6px var(--gw-accent-green-soft);
      }
      .gw-conn-status.disconnected { background: var(--gw-text-quaternary); }
      .gw-conn-name { font-size: 13px; font-weight: 500; color: var(--gw-text-primary); }
      .gw-conn-meta { font-size: 10px; color: var(--gw-text-quaternary); margin-top: 1px; }
      .gw-conn-actions { display: flex; gap: 4px; }
      .gw-btn {
        padding: 5px 12px; border-radius: var(--gw-radius-sm); border: 1px solid var(--gw-hairline);
        background: transparent; color: var(--gw-text-tertiary); cursor: pointer;
        font-size: 10px; font-family: var(--gw-font); transition: all 0.15s;
        display: flex; align-items: center; gap: 4px;
      }
      .gw-btn:hover { border-color: var(--gw-hairline-strong); color: var(--gw-text-primary); }
      .gw-btn-connect { border-color: var(--gw-accent-green); color: var(--gw-accent-green); }
      .gw-btn-connect:hover { background: var(--gw-accent-green-soft); }
      .gw-btn-danger { border-color: rgba(255,97,97,0.3); color: rgba(255,97,97,0.6); }
      .gw-btn-danger:hover { border-color: var(--gw-accent-red); color: var(--gw-accent-red); background: var(--gw-accent-red-soft); }
      .gw-btn-primary { background: var(--gw-text-primary); color: var(--gw-canvas); border-color: var(--gw-text-primary); }
      .gw-btn-primary:hover { opacity: 0.85; }
      .gw-btn-sm { padding: 3px 8px; font-size: 9px; }

      /* \u2500\u2500 Health Dashboard \u2500\u2500 */
      .gw-health-card {
        padding: 16px; background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); margin-bottom: 12px;
      }
      .gw-health-title {
        font-size: 10px; font-weight: 600; color: var(--gw-text-quaternary);
        letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px;
      }
      .gw-health-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 8px;
      }
      .gw-health-item {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; background: var(--gw-surface-elevated);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-sm);
      }
      .gw-health-dot {
        width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        animation: gw-pulse 2s ease-in-out infinite;
      }
      .gw-health-name { font-size: 12px; font-weight: 500; color: var(--gw-text-primary); }
      .gw-health-detail { font-size: 10px; color: var(--gw-text-quaternary); margin-top: 1px; }
      .gw-health-stats {
        margin-left: auto; text-align: right; font-size: 10px;
        color: var(--gw-text-tertiary); white-space: nowrap;
      }

      /* \u2500\u2500 Message Bubbles \u2500\u2500 */
      .gw-inbox-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 12px; gap: 8px;
      }
      .gw-inbox-count {
        font-size: 10px; color: var(--gw-text-quaternary); letter-spacing: 0.5px;
      }
      .gw-inbox-list {
        max-height: 400px; overflow-y: auto; padding-right: 4px;
      }
      .gw-inbox-list::-webkit-scrollbar { width: 4px; }
      .gw-inbox-list::-webkit-scrollbar-track { background: transparent; }
      .gw-inbox-list::-webkit-scrollbar-thumb { background: var(--gw-hairline); border-radius: 2px; }

      .gw-msg-bubble {
        display: flex; gap: 10px; padding: 10px 14px; margin-bottom: 6px;
        background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); transition: border-color 0.15s, cursor 0.15s;
        animation: gw-msg-in 0.2s ease-out; cursor: pointer;
      }
      .gw-msg-bubble:hover { border-color: var(--gw-hairline-strong); }
      @keyframes gw-msg-in { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }

      .gw-msg-avatar {
        width: 32px; height: 32px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 600; flex-shrink: 0; color: #fff;
      }
      .gw-msg-body { flex: 1; min-width: 0; }
      .gw-msg-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .gw-msg-sender { font-size: 12px; font-weight: 500; color: var(--gw-text-primary); }
      .gw-msg-platform-badge {
        font-size: 8px; letter-spacing: 0.5px; text-transform: uppercase;
        padding: 1px 6px; border-radius: 3px; font-weight: 500;
      }
      .gw-msg-time { font-size: 9px; color: var(--gw-text-quaternary); margin-left: auto; }
      .gw-msg-text { font-size: 12px; line-height: 1.6; color: var(--gw-text-secondary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .gw-msg-media {
        display: inline-block; padding: 1px 6px; margin-top: 4px;
        font-size: 8px; border-radius: 3px; letter-spacing: 0.5px; text-transform: uppercase;
      }

      /* \u2500\u2500 Message Detail Panel \u2500\u2500 */
      .gw-detail-panel {
        padding: 16px; background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); margin-bottom: 16px;
        animation: gw-msg-in 0.2s ease-out;
      }
      .gw-detail-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 12px; padding-bottom: 10px;
        border-bottom: 1px solid var(--gw-hairline);
      }
      .gw-detail-title { font-size: 12px; font-weight: 600; color: var(--gw-text-primary); }
      .gw-detail-meta { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; margin-bottom: 12px; }
      .gw-detail-label { font-size: 10px; color: var(--gw-text-quaternary); text-transform: uppercase; letter-spacing: 0.5px; }
      .gw-detail-value { font-size: 11px; color: var(--gw-text-secondary); word-break: break-all; }
      .gw-detail-content {
        padding: 12px; background: var(--gw-surface-elevated); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-sm); font-size: 12px; line-height: 1.6;
        color: var(--gw-text-secondary); white-space: pre-wrap; word-break: break-word;
        max-height: 200px; overflow-y: auto;
      }

      /* \u2500\u2500 Compose Box \u2500\u2500 */
      .gw-compose {
        margin-top: 12px; padding: 12px; background: var(--gw-surface);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-md);
      }
      .gw-compose-label {
        font-size: 9px; color: var(--gw-text-quaternary); letter-spacing: 1px;
        text-transform: uppercase; margin-bottom: 8px;
      }
      .gw-compose-row { display: flex; gap: 8px; align-items: flex-end; }
      .gw-compose-input {
        flex: 1; background: var(--gw-surface-elevated); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-sm); padding: 8px 12px; color: var(--gw-text-primary);
        font-size: 12px; font-family: var(--gw-font); outline: none; resize: none;
        min-height: 36px; max-height: 80px; transition: border-color 0.15s;
      }
      .gw-compose-input:focus { border-color: var(--gw-accent-blue); }
      .gw-compose-input::placeholder { color: var(--gw-text-quaternary); }
      .gw-compose-send {
        padding: 8px 14px; border-radius: var(--gw-radius-sm); border: none;
        background: var(--gw-text-primary); color: var(--gw-canvas); cursor: pointer;
        font-size: 11px; font-weight: 500; font-family: var(--gw-font);
        display: flex; align-items: center; gap: 5px; transition: opacity 0.15s;
        white-space: nowrap;
      }
      .gw-compose-send:hover { opacity: 0.85; }
      .gw-compose-send:disabled { opacity: 0.25; cursor: default; }
      .gw-compose-target {
        margin-bottom: 8px; display: flex; gap: 6px; align-items: center;
      }
      .gw-compose-target label {
        font-size: 10px; color: var(--gw-text-tertiary);
      }
      .gw-compose-target select {
        background: var(--gw-surface-elevated); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-sm); padding: 4px 8px; color: var(--gw-text-primary);
        font-size: 10px; font-family: var(--gw-font); outline: none; cursor: pointer;
      }

      /* \u2500\u2500 Search Bar \u2500\u2500 */
      .gw-search-bar {
        display: flex; gap: 6px; margin-bottom: 12px; align-items: center;
      }
      .gw-search-input {
        flex: 1; padding: 6px 10px; background: var(--gw-surface-elevated);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-sm);
        color: var(--gw-text-primary); font-size: 11px; font-family: var(--gw-font);
        outline: none; transition: border-color 0.15s;
      }
      .gw-search-input:focus { border-color: var(--gw-accent-blue); }
      .gw-search-input::placeholder { color: var(--gw-text-quaternary); }
      .gw-search-select {
        padding: 6px 8px; background: var(--gw-surface-elevated);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-sm);
        color: var(--gw-text-primary); font-size: 10px; font-family: var(--gw-font);
        outline: none; cursor: pointer;
      }

      /* \u2500\u2500 Wizard Panel \u2500\u2500 */
      .gw-wizard {
        padding: 20px; background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); margin-bottom: 16px;
        animation: gw-msg-in 0.3s ease-out;
      }
      .gw-wizard-title {
        font-size: 14px; font-weight: 600; color: var(--gw-text-primary);
        margin-bottom: 4px;
      }
      .gw-wizard-subtitle {
        font-size: 11px; color: var(--gw-text-tertiary); margin-bottom: 16px;
      }
      .gw-wizard-steps { list-style: none; padding: 0; margin: 0 0 16px 0; }
      .gw-wizard-step {
        display: flex; align-items: flex-start; gap: 10px; padding: 10px 0;
        border-bottom: 1px solid var(--gw-hairline-soft);
      }
      .gw-wizard-step:last-child { border-bottom: none; }
      .gw-wizard-step-num {
        width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 700;
        background: var(--gw-surface-elevated); border: 1px solid var(--gw-hairline);
        color: var(--gw-text-tertiary);
      }
      .gw-wizard-step.active .gw-wizard-step-num {
        background: var(--gw-accent-blue-soft); border-color: var(--gw-accent-blue);
        color: var(--gw-accent-blue);
      }
      .gw-wizard-step-text { font-size: 12px; color: var(--gw-text-secondary); line-height: 1.5; }
      .gw-wizard-step.active .gw-wizard-step-text { color: var(--gw-text-primary); }

      /* \u2500\u2500 Templates \u2500\u2500 */
      .gw-template-card {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; margin-bottom: 6px; background: var(--gw-surface);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-md);
        transition: border-color 0.15s;
      }
      .gw-template-card:hover { border-color: var(--gw-hairline-strong); }
      .gw-template-info { flex: 1; min-width: 0; }
      .gw-template-name { font-size: 12px; font-weight: 500; color: var(--gw-text-primary); }
      .gw-template-meta { font-size: 9px; color: var(--gw-text-quaternary); margin-top: 2px; }
      .gw-template-preview { font-size: 10px; color: var(--gw-text-tertiary); margin-top: 4px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }

      /* \u2500\u2500 Retry Queue \u2500\u2500 */
      .gw-retry-card {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; margin-bottom: 6px; background: var(--gw-surface);
        border: 1px solid var(--gw-hairline); border-radius: var(--gw-radius-md);
      }
      .gw-retry-status {
        padding: 2px 6px; border-radius: 3px; font-size: 8px; font-weight: 600;
        letter-spacing: 0.5px; text-transform: uppercase;
      }
      .gw-retry-status.pending { background: var(--gw-accent-yellow-soft); color: var(--gw-accent-yellow); }
      .gw-retry-status.failed { background: var(--gw-accent-red-soft); color: var(--gw-accent-red); }
      .gw-retry-status.sent { background: var(--gw-accent-green-soft); color: var(--gw-accent-green); }

      /* \u2500\u2500 Add Form \u2500\u2500 */
      .gw-add-form {
        padding: 16px; background: var(--gw-surface); border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-md); margin-top: 12px;
        animation: gw-msg-in 0.2s ease-out;
      }
      .gw-add-form-title { font-size: 13px; font-weight: 500; margin-bottom: 12px; color: var(--gw-text-primary); }
      .gw-form-field { margin-bottom: 10px; }
      .gw-form-label {
        display: block; font-size: 10px; color: var(--gw-text-tertiary);
        letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 4px;
      }
      .gw-form-input {
        width: 100%; padding: 7px 10px; border: 1px solid var(--gw-hairline);
        border-radius: var(--gw-radius-sm); background: var(--gw-surface-elevated);
        color: var(--gw-text-primary); font-size: 12px; font-family: var(--gw-font);
        outline: none; transition: border-color 0.15s;
      }
      .gw-form-input:focus { border-color: var(--gw-accent-blue); }
      .gw-form-input::placeholder { color: var(--gw-text-quaternary); }
      .gw-form-help { font-size: 9px; color: var(--gw-text-quaternary); margin-top: 3px; }
      .gw-form-actions { display: flex; gap: 8px; margin-top: 12px; }
      .gw-form-save {
        padding: 6px 16px; border-radius: var(--gw-radius-sm); border: none;
        background: var(--gw-text-primary); color: var(--gw-canvas);
        font-size: 11px; font-weight: 500; cursor: pointer; font-family: var(--gw-font);
      }
      .gw-form-save:hover { opacity: 0.85; }
      .gw-form-cancel {
        padding: 6px 16px; border-radius: var(--gw-radius-sm); border: 1px solid var(--gw-hairline);
        background: transparent; color: var(--gw-text-tertiary); font-size: 11px;
        cursor: pointer; font-family: var(--gw-font);
      }
      .gw-form-cancel:hover { border-color: var(--gw-hairline-strong); color: var(--gw-text-primary); }

      /* \u2500\u2500 Empty States \u2500\u2500 */
      .gw-empty {
        padding: 32px 0; text-align: center; color: var(--gw-text-quaternary);
        font-size: 11px; letter-spacing: 0.3px;
      }
      .gw-empty svg { margin-bottom: 8px; opacity: 0.2; }

      /* \u2500\u2500 Section Legend \u2500\u2500 */
      .gw-section-legend {
        font-size: 9px; color: var(--gw-text-quaternary); letter-spacing: 1.5px;
        text-transform: uppercase; margin-bottom: 10px; font-weight: 500;
      }
    `;
      document.head.appendChild(style);
    }
    onEnter() {
      this._load();
      this._connectWebSocket();
    }
    onExit() {
      this._disconnectWebSocket();
    }
    // ── WebSocket ──
    _connectWebSocket() {
      if (this._ws) return;
      try {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        this._ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        this._ws.onopen = () => {
          this._wsConnected = true;
          this._updateWsStatus();
        };
        this._ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "gateway:message") {
              this._inbox.push(msg);
              this._renderInboxTab();
              this._bumpCounter();
            }
          } catch {
          }
        };
        this._ws.onclose = () => {
          this._ws = null;
          this._wsConnected = false;
          this._updateWsStatus();
          this._wsReconnectTimer = setTimeout(() => this._connectWebSocket(), 3e3);
        };
        this._ws.onerror = () => {
          this._ws?.close();
        };
      } catch {
      }
    }
    _disconnectWebSocket() {
      if (this._wsReconnectTimer) clearTimeout(this._wsReconnectTimer);
      if (this._ws) this._ws.close();
      this._ws = null;
    }
    _updateWsStatus() {
      const dot = this.container.querySelector(".gw-ws-dot");
      const label = this.container.querySelector(".gw-ws-label");
      if (dot) dot.classList.toggle("connected", this._wsConnected);
      if (label) label.textContent = this._wsConnected ? "Live" : "Reconnecting...";
    }
    _bumpCounter() {
      const counter = this.container.querySelector(".gw-msg-counter");
      if (counter) {
        counter.textContent = String(this._inbox.length);
        counter.classList.remove("bump");
        void counter.offsetWidth;
        counter.classList.add("bump");
      }
    }
    // ── Data ──
    async _load() {
      try {
        const r = await fetch("/api/gateway/connections");
        if (r.ok) {
          const d = await r.json();
          this._connections = d.connections || [];
        }
      } catch {
        this._connections = [];
      }
      try {
        const r = await fetch("/api/gateway/inbox");
        if (r.ok) {
          const d = await r.json();
          this._inbox = d.messages || [];
        }
      } catch {
        this._inbox = [];
      }
      try {
        const r = await fetch("/api/gateway/health");
        if (r.ok) {
          this._health = await r.json();
        }
      } catch {
        this._health = null;
      }
      try {
        const r = await fetch("/api/gateway/templates");
        if (r.ok) {
          const d = await r.json();
          this._templates = d.templates || [];
        }
      } catch {
        this._templates = [];
      }
      try {
        const r = await fetch("/api/gateway/retry-queue");
        if (r.ok) {
          const d = await r.json();
          this._retryQueue = d.queue || [];
        }
      } catch {
        this._retryQueue = [];
      }
      this._render();
    }
    // ── Rendering ──
    _render() {
      const inner = this.container.querySelector(".gw-inner");
      inner.innerHTML = `
      <div class="gw-header">
        <div class="gw-header-title">Gateway</div>
        <div class="gw-header-status">
          <span class="gw-msg-counter">${this._inbox.length}</span>
          <span class="gw-ws-dot ${this._wsConnected ? "connected" : ""}"></span>
          <span class="gw-ws-label">${this._wsConnected ? "Live" : "Reconnecting..."}</span>
        </div>
      </div>

      <div class="gw-platforms-label">Platforms</div>
      <div class="gw-platforms-grid">
        ${PLATFORMS.map((p) => `
          <div class="gw-platform-card" data-platform="${p.id}">
            <div class="gw-platform-icon" style="color:${p.color};">
              ${platformIcon(p.icon)}
            </div>
            <div class="gw-platform-name">${p.name}</div>
            <div class="gw-platform-desc">${this._connections.filter((c) => c.platform === p.id).length} connection${this._connections.filter((c) => c.platform === p.id).length !== 1 ? "s" : ""}</div>
          </div>`).join("")}
      </div>

      ${this._connections.length ? `
        <div class="gw-section-legend" style="margin-bottom:8px;">Connections</div>
        ${this._connections.map((c) => `
          <div class="gw-conn-card">
            <div class="gw-conn-info">
              <span class="gw-conn-status ${c.connected ? "connected" : "disconnected"}"></span>
              <div>
                <div class="gw-conn-name">${esc(c.name || c.id)}</div>
                <div class="gw-conn-meta">${c.platform} \xB7 ${c.connected ? "Connected" : "Disconnected"}</div>
              </div>
            </div>
            <div class="gw-conn-actions">
              <button class="gw-btn gw-btn-sm" data-act="wizard" data-id="${c.id}" title="Setup Guide">${ICONS.wizard}</button>
              <button class="gw-btn ${c.connected ? "gw-btn-danger" : "gw-btn-connect"}" data-act="toggle" data-id="${c.id}">
                ${c.connected ? `${ICONS.disconnect} Disconnect` : `${ICONS.connect} Connect`}
              </button>
              <button class="gw-btn gw-btn-danger" data-act="remove" data-id="${c.id}">
                ${ICONS.trash}
              </button>
            </div>
          </div>`).join("")}
      ` : `<div class="gw-empty">${ICONS.connect}<br>No connections configured.<br>Click a platform above to add one.</div>`}

      <div class="gw-tabs" style="margin-top:20px;">
        <button class="gw-tab ${this._activeTab === "inbox" ? "active" : ""}" data-tab="inbox">${ICONS.inbox} Inbox <span class="gw-tab-badge">${this._inbox.length}</span></button>
        <button class="gw-tab ${this._activeTab === "templates" ? "active" : ""}" data-tab="templates">${ICONS.template} Templates</button>
        <button class="gw-tab ${this._activeTab === "retry" ? "active" : ""}" data-tab="retry">${ICONS.retry} Retry ${this._retryQueue.length > 0 ? `<span class="gw-tab-badge">${this._retryQueue.length}</span>` : ""}</button>
        <button class="gw-tab ${this._activeTab === "health" ? "active" : ""}" data-tab="health">${ICONS.health} Health</button>
      </div>

      <div id="gw-tab-content"></div>
    `;
      inner.querySelectorAll(".gw-platform-card").forEach((card) => {
        card.addEventListener("click", () => this._showAdd(card.dataset.platform));
      });
      Array.from(inner.querySelectorAll("[data-act]")).forEach((el) => {
        const h = el;
        const act = h.dataset.act;
        const id = h.dataset.id;
        if (act === "toggle") el.addEventListener("click", () => this.toggle(id));
        if (act === "remove") el.addEventListener("click", () => this.remove(id));
        if (act === "wizard") el.addEventListener("click", () => this._showWizard(id));
      });
      inner.querySelectorAll(".gw-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          this._activeTab = tab.dataset.tab;
          this._selectedMessage = null;
          this._searchResults = null;
          this._render();
        });
      });
      this._renderTabContent();
    }
    _renderTabContent() {
      const el = this.container.querySelector("#gw-tab-content");
      if (this._activeTab === "inbox") {
        el.innerHTML = this._renderInboxTabHtml();
        this._bindInboxCompose();
      } else if (this._activeTab === "templates") {
        el.innerHTML = this._renderTemplatesTabHtml();
        this._bindTemplatesTab();
      } else if (this._activeTab === "retry") {
        el.innerHTML = this._renderRetryTabHtml();
        this._bindRetryTab();
      } else {
        el.innerHTML = this._renderHealthTabHtml();
      }
    }
    _renderInboxTab() {
      const el = this.container.querySelector("#gw-tab-content");
      if (el && this._activeTab === "inbox") {
        el.innerHTML = this._renderInboxTabHtml();
        this._bindInboxCompose();
      }
    }
    _renderInboxTabHtml() {
      const platformColors = {
        telegram: { bg: "rgba(87,193,255,0.15)", fg: "#57c1ff" },
        wechat: { bg: "rgba(89,212,153,0.15)", fg: "#59d499" },
        feishu: { bg: "rgba(255,197,51,0.15)", fg: "#ffc533" }
      };
      const displayMessages = this._searchResults !== null ? this._searchResults : this._inbox;
      const msgs = displayMessages.slice(-30).reverse();
      const searchBar = `
      <div class="gw-search-bar">
        <input class="gw-search-input" id="gw-search-input" type="text" placeholder="Search messages..." value="${esc(this._searchQuery)}">
        <select class="gw-search-select" id="gw-search-platform">
          <option value="">All platforms</option>
          <option value="telegram" ${this._searchPlatform === "telegram" ? "selected" : ""}>Telegram</option>
          <option value="wechat" ${this._searchPlatform === "wechat" ? "selected" : ""}>WeChat</option>
          <option value="feishu" ${this._searchPlatform === "feishu" ? "selected" : ""}>Feishu</option>
        </select>
        <button class="gw-btn gw-btn-sm" id="gw-search-btn">${ICONS.search} Search</button>
        ${this._searchResults !== null ? `<button class="gw-btn gw-btn-sm" id="gw-search-clear">Clear</button>` : ""}
      </div>`;
      const detailView = this._selectedMessage ? this._renderMessageDetail(this._selectedMessage) : "";
      const bubbleList = msgs.length === 0 ? `<div class="gw-empty">${ICONS.inbox}<br>${this._searchResults !== null ? "No messages match your search." : "No messages yet."}</div>` : `<div class="gw-inbox-list">
          ${msgs.map((m) => {
        const pc = platformColors[m.platform] || { bg: "rgba(255,255,255,0.08)", fg: "#9c9c9d" };
        const initials = (m.senderId || "?").slice(0, 2).toUpperCase();
        const mediaTag = m.media_type && m.media_type !== "text" ? `<span class="gw-msg-media" style="background:${pc.bg};color:${pc.fg};">${m.media_type}</span>` : "";
        const isSelected = this._selectedMessage && this._selectedMessage.timestamp === m.timestamp && this._selectedMessage.senderId === m.senderId;
        return `
              <div class="gw-msg-bubble ${isSelected ? "selected" : ""}" data-idx="${this._inbox.indexOf(m)}">
                <div class="gw-msg-avatar" style="background:${pc.bg};color:${pc.fg};">${initials}</div>
                <div class="gw-msg-body">
                  <div class="gw-msg-header">
                    <span class="gw-msg-sender">${esc(m.senderId || "Unknown")}</span>
                    <span class="gw-msg-platform-badge" style="background:${pc.bg};color:${pc.fg};">${m.platform}</span>
                    <span class="gw-msg-time">${timeAgo(m.timestamp)}</span>
                  </div>
                  <div class="gw-msg-text">${esc(m.text || "")}${mediaTag}</div>
                </div>
              </div>`;
      }).join("")}
        </div>`;
      const connectedConns = this._connections.filter((c) => c.connected);
      const composeBox = connectedConns.length > 0 ? `
      <div class="gw-compose">
        <div class="gw-compose-label">Send Message</div>
        <div class="gw-compose-target">
          <label>Target:</label>
          <select id="gw-compose-target">
            ${connectedConns.map((c) => `<option value="${c.id}">${esc(c.name || c.id)} (${c.platform})</option>`).join("")}
          </select>
        </div>
        <div class="gw-compose-row">
          <textarea class="gw-compose-input" id="gw-compose-input" placeholder="Type a message..." rows="1"></textarea>
          <button class="gw-compose-send" id="gw-compose-send">${ICONS.send} Send</button>
        </div>
      </div>
    ` : "";
      return `
      ${searchBar}
      ${detailView}
      <div class="gw-inbox-header">
        <div class="gw-inbox-count">${displayMessages.length} message${displayMessages.length !== 1 ? "s" : ""}${this._searchResults !== null ? " (filtered)" : ""}</div>
        ${this._inbox.length > 0 ? `<button class="gw-btn gw-btn-danger gw-btn-sm" id="gw-clear-inbox">${ICONS.trash} Clear</button>` : ""}
      </div>
      ${bubbleList}
      ${composeBox}
    `;
    }
    _renderMessageDetail(msg) {
      const pc = { telegram: { bg: "rgba(87,193,255,0.15)", fg: "#57c1ff" }, wechat: { bg: "rgba(89,212,153,0.15)", fg: "#59d499" }, feishu: { bg: "rgba(255,197,51,0.15)", fg: "#ffc533" } }[msg.platform] || { bg: "rgba(255,255,255,0.08)", fg: "#9c9c9d" };
      return `
      <div class="gw-detail-panel">
        <div class="gw-detail-header">
          <div class="gw-detail-title">${ICONS.detail} Message Detail</div>
          <button class="gw-btn gw-btn-sm" id="gw-detail-close">${ICONS.close} Close</button>
        </div>
        <div class="gw-detail-meta">
          <span class="gw-detail-label">Platform</span>
          <span class="gw-detail-value"><span class="gw-msg-platform-badge" style="background:${pc.bg};color:${pc.fg};">${msg.platform}</span></span>
          <span class="gw-detail-label">Sender</span>
          <span class="gw-detail-value">${esc(msg.senderId || "Unknown")}</span>
          <span class="gw-detail-label">Chat ID</span>
          <span class="gw-detail-value">${esc(msg.chatId || "N/A")}</span>
          <span class="gw-detail-label">Time</span>
          <span class="gw-detail-value">${msg.timestamp ? new Date(msg.timestamp).toLocaleString() : "N/A"}</span>
          ${msg.media_type ? `<span class="gw-detail-label">Media</span><span class="gw-detail-value">${esc(msg.media_type)}${msg.media_url ? ` - ${esc(msg.media_url)}` : ""}</span>` : ""}
          ${msg.callback_data ? `<span class="gw-detail-label">Callback</span><span class="gw-detail-value">${esc(msg.callback_data)}</span>` : ""}
          ${msg.connectionId ? `<span class="gw-detail-label">Connection</span><span class="gw-detail-value">${esc(msg.connectionId)}</span>` : ""}
        </div>
        <div class="gw-detail-content">${esc(msg.text || "(no text content)")}</div>
      </div>`;
    }
    _bindInboxCompose() {
      const clearBtn = this.container.querySelector("#gw-clear-inbox");
      if (clearBtn) clearBtn.addEventListener("click", () => this.clearInbox());
      const searchBtn = this.container.querySelector("#gw-search-btn");
      const searchInput = this.container.querySelector("#gw-search-input");
      const searchPlatform = this.container.querySelector("#gw-search-platform");
      const searchClear = this.container.querySelector("#gw-search-clear");
      if (searchBtn && searchInput && searchPlatform) {
        const doSearch = async () => {
          this._searchQuery = searchInput.value.trim();
          this._searchPlatform = searchPlatform.value;
          const params = new URLSearchParams();
          if (this._searchQuery) params.set("q", this._searchQuery);
          if (this._searchPlatform) params.set("platform", this._searchPlatform);
          try {
            const r = await fetch(`/api/gateway/search?${params.toString()}`);
            if (r.ok) {
              const d = await r.json();
              this._searchResults = d.messages || [];
            }
          } catch {
            this._searchResults = null;
          }
          this._renderInboxTab();
        };
        searchBtn.addEventListener("click", doSearch);
        searchInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") doSearch();
        });
      }
      if (searchClear) {
        searchClear.addEventListener("click", () => {
          this._searchQuery = "";
          this._searchPlatform = "";
          this._searchResults = null;
          this._renderInboxTab();
        });
      }
      this.container.querySelectorAll(".gw-msg-bubble").forEach((bubble) => {
        bubble.addEventListener("click", () => {
          const idx = parseInt(bubble.dataset.idx || "-1");
          if (idx >= 0 && idx < this._inbox.length) {
            this._selectedMessage = this._inbox[idx];
            this._renderInboxTab();
          }
        });
      });
      const detailClose = this.container.querySelector("#gw-detail-close");
      if (detailClose) {
        detailClose.addEventListener("click", () => {
          this._selectedMessage = null;
          this._renderInboxTab();
        });
      }
      const sendBtn = this.container.querySelector("#gw-compose-send");
      const input = this.container.querySelector("#gw-compose-input");
      const target = this.container.querySelector("#gw-compose-target");
      if (sendBtn && input && target) {
        const doSend = async () => {
          const text = input.value.trim();
          if (!text) return;
          sendBtn.setAttribute("disabled", "true");
          try {
            await fetch(`/api/gateway/connections/${target.value}/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text })
            });
            input.value = "";
          } catch {
          }
          sendBtn.removeAttribute("disabled");
        };
        sendBtn.addEventListener("click", doSend);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            doSend();
          }
        });
        input.addEventListener("input", () => {
          input.style.height = "auto";
          input.style.height = Math.min(input.scrollHeight, 80) + "px";
        });
      }
    }
    _renderTemplatesTabHtml() {
      if (this._templates.length === 0) {
        return `<div class="gw-empty">${ICONS.template}<br>No templates yet.<br>Create one to reuse message formats.</div>`;
      }
      return `
      <div class="gw-inbox-header">
        <div class="gw-inbox-count">${this._templates.length} template${this._templates.length !== 1 ? "s" : ""}</div>
        <button class="gw-btn gw-btn-sm gw-btn-primary" id="gw-add-template">+ New Template</button>
      </div>
      ${this._templates.map((t) => `
        <div class="gw-template-card">
          <div class="gw-template-info">
            <div class="gw-template-name">${esc(t.name)}</div>
            <div class="gw-template-meta">${t.platform} \xB7 ${t.category} \xB7 ${t.mediaType}</div>
            <div class="gw-template-preview">${esc(t.content)}</div>
          </div>
          <div class="gw-conn-actions">
            <button class="gw-btn gw-btn-sm" data-act="use-template" data-id="${t.id}">Use</button>
            <button class="gw-btn gw-btn-sm gw-btn-danger" data-act="delete-template" data-id="${t.id}">${ICONS.trash}</button>
          </div>
        </div>`).join("")}
    `;
    }
    _bindTemplatesTab() {
      const addBtn = this.container.querySelector("#gw-add-template");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          const inner = this.container.querySelector(".gw-inner");
          const existing = inner.querySelector("#gw-add-form");
          if (existing) existing.remove();
          const form = document.createElement("div");
          form.id = "gw-add-form";
          form.className = "gw-add-form";
          form.innerHTML = `
          <div class="gw-add-form-title">Create Template</div>
          <div class="gw-form-field">
            <label class="gw-form-label">Name</label>
            <input class="gw-form-input" id="gw-tpl-name" type="text" placeholder="e.g., Welcome Message">
          </div>
          <div class="gw-form-field">
            <label class="gw-form-label">Platform</label>
            <select class="gw-form-input" id="gw-tpl-platform">
              <option value="any">Any</option>
              <option value="telegram">Telegram</option>
              <option value="wechat">WeChat</option>
              <option value="feishu">Feishu</option>
            </select>
          </div>
          <div class="gw-form-field">
            <label class="gw-form-label">Content (use {{variable}} for substitution)</label>
            <textarea class="gw-form-input" id="gw-tpl-content" rows="3" placeholder="Hello {{name}}, welcome to {{group}}!"></textarea>
          </div>
          <div class="gw-form-field">
            <label class="gw-form-label">Category</label>
            <input class="gw-form-input" id="gw-tpl-category" type="text" placeholder="e.g., welcome, notification" value="general">
          </div>
          <div class="gw-form-actions">
            <button class="gw-form-save">Create</button>
            <button class="gw-form-cancel">Cancel</button>
          </div>`;
          inner.appendChild(form);
          form.querySelector(".gw-form-save")?.addEventListener("click", async () => {
            const name = document.getElementById("gw-tpl-name")?.value || "";
            const platform = document.getElementById("gw-tpl-platform")?.value || "any";
            const content = document.getElementById("gw-tpl-content")?.value || "";
            const category = document.getElementById("gw-tpl-category")?.value || "general";
            await fetch("/api/gateway/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, platform, content, category }) });
            form.remove();
            this._load();
          });
          form.querySelector(".gw-form-cancel")?.addEventListener("click", () => form.remove());
        });
      }
      this.container.querySelectorAll('[data-act="use-template"]').forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          try {
            const r = await fetch(`/api/gateway/templates/${id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
            if (r.ok) {
              const d = await r.json();
              alert(`Template applied:

${d.content}`);
            }
          } catch {
          }
        });
      });
      this.container.querySelectorAll('[data-act="delete-template"]').forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!confirm("Delete this template?")) return;
          await fetch(`/api/gateway/templates/${id}`, { method: "DELETE" });
          this._load();
        });
      });
    }
    _renderRetryTabHtml() {
      if (this._retryQueue.length === 0) {
        return `<div class="gw-empty">${ICONS.retry}<br>No pending retries.</div>`;
      }
      return `
      <div class="gw-inbox-header">
        <div class="gw-inbox-count">${this._retryQueue.length} item${this._retryQueue.length !== 1 ? "s" : ""} in queue</div>
        <button class="gw-btn gw-btn-sm gw-btn-danger" id="gw-clear-retry">${ICONS.trash} Clear All</button>
      </div>
      ${this._retryQueue.map((r) => `
        <div class="gw-retry-card">
          <span class="gw-retry-status ${r.status}">${r.status}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;color:var(--gw-text-primary);">${esc(r.platform)} -> ${esc(r.chatId)}</div>
            <div style="font-size:10px;color:var(--gw-text-quaternary);margin-top:2px;">Attempt ${r.attempt}/${r.maxAttempts} \xB7 ${r.lastError ? esc(r.lastError) : "Waiting..."}</div>
          </div>
          <div style="font-size:9px;color:var(--gw-text-quaternary);text-align:right;">
            <div>${timeAgo(r.createdAt)}</div>
            ${r.status === "pending" ? `<div>Next: ${new Date(r.nextRetryAt).toLocaleTimeString()}</div>` : ""}
          </div>
          <button class="gw-btn gw-btn-sm gw-btn-danger" data-act="remove-retry" data-id="${r.id}">${ICONS.trash}</button>
        </div>`).join("")}
    `;
    }
    _bindRetryTab() {
      const clearBtn = this.container.querySelector("#gw-clear-retry");
      if (clearBtn) {
        clearBtn.addEventListener("click", async () => {
          await fetch("/api/gateway/retry-queue", { method: "DELETE" });
          this._load();
        });
      }
      this.container.querySelectorAll('[data-act="remove-retry"]').forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          await fetch(`/api/gateway/retry-queue/${id}`, { method: "DELETE" });
          this._load();
        });
      });
    }
    _renderHealthTabHtml() {
      if (!this._health) return '<div class="gw-empty">No health data available.</div>';
      const adapters = this._health.adapters || {};
      const keys = Object.keys(adapters);
      if (!keys.length) return '<div class="gw-empty">No adapters reporting.</div>';
      return `
      <div class="gw-health-card">
        <div class="gw-health-title">Adapter Status</div>
        <div class="gw-health-grid">
          ${keys.map((id) => {
        const a = adapters[id];
        const dotColor = a.connected ? "var(--gw-accent-green)" : "var(--gw-accent-red)";
        return `
              <div class="gw-health-item">
                <span class="gw-health-dot" style="background:${dotColor};${a.connected ? "box-shadow:0 0 6px " + dotColor + "30" : ""}"></span>
                <div>
                  <div class="gw-health-name">${esc(id)}</div>
                  <div class="gw-health-detail">${a.platform} \xB7 ${a.connected ? "Connected" : "Disconnected"}</div>
                </div>
                <div class="gw-health-stats">
                  ${a.totalReceived ? `<div>${a.totalReceived} msgs</div>` : ""}
                  ${a.uptime ? `<div>up ${formatUptime(a.uptime)}</div>` : ""}
                </div>
              </div>`;
      }).join("")}
        </div>
      </div>`;
    }
    // ── Connection Wizard ──
    _showWizard(connectionId) {
      const conn = this._connections.find((c) => c.id === connectionId);
      if (!conn) return;
      const platform = PLATFORMS.find((p) => p.id === conn.platform);
      if (!platform || !platform.setupSteps) return;
      const inner = this.container.querySelector(".gw-inner");
      const existing = inner.querySelector("#gw-wizard-panel");
      if (existing) existing.remove();
      const panel = document.createElement("div");
      panel.id = "gw-wizard-panel";
      panel.className = "gw-wizard";
      panel.innerHTML = `
      <div class="gw-detail-header">
        <div>
          <div class="gw-wizard-title">${platform.name} Setup Guide</div>
          <div class="gw-wizard-subtitle">Follow these steps to connect your ${platform.name} bot</div>
        </div>
        <button class="gw-btn gw-btn-sm" id="gw-wizard-close">${ICONS.close} Close</button>
      </div>
      <ol class="gw-wizard-steps">
        ${platform.setupSteps.map((step, i) => `
          <li class="gw-wizard-step ${i <= this._wizardStep ? "active" : ""}">
            <span class="gw-wizard-step-num">${i + 1}</span>
            <span class="gw-wizard-step-text">${esc(step)}</span>
          </li>`).join("")}
      </ol>
      <div style="display:flex;gap:8px;">
        <button class="gw-btn gw-btn-sm" id="gw-wizard-prev" ${this._wizardStep === 0 ? 'disabled style="opacity:0.3"' : ""}>Previous</button>
        <button class="gw-btn gw-btn-sm gw-btn-primary" id="gw-wizard-next">${this._wizardStep >= platform.setupSteps.length - 1 ? "Done" : "Next"}</button>
      </div>
    `;
      inner.appendChild(panel);
      panel.querySelector("#gw-wizard-close")?.addEventListener("click", () => {
        panel.remove();
        this._wizardStep = 0;
      });
      panel.querySelector("#gw-wizard-prev")?.addEventListener("click", () => {
        if (this._wizardStep > 0) {
          this._wizardStep--;
          this._showWizard(connectionId);
        }
      });
      panel.querySelector("#gw-wizard-next")?.addEventListener("click", () => {
        if (this._wizardStep < platform.setupSteps.length - 1) {
          this._wizardStep++;
          this._showWizard(connectionId);
        } else {
          panel.remove();
          this._wizardStep = 0;
        }
      });
    }
    // ── Add Connection Form ──
    _showAdd(platform) {
      const p = PLATFORMS.find((p2) => p2.id === platform);
      if (!p) return;
      const inner = this.container.querySelector(".gw-inner");
      const existing = inner.querySelector("#gw-add-form");
      if (existing) existing.remove();
      const form = document.createElement("div");
      form.id = "gw-add-form";
      form.className = "gw-add-form";
      form.innerHTML = `
      <div class="gw-add-form-title">Add ${p.name} Connection</div>
      ${p.fields.map((f) => `
        <div class="gw-form-field">
          <label class="gw-form-label">${f.label}</label>
          <input class="gw-form-input" id="gw-f-${f.key}" type="${f.type}" placeholder="${f.placeholder || ""}">
          ${f.help ? `<div class="gw-form-help">${esc(f.help)}</div>` : ""}
        </div>`).join("")}
      <div class="gw-form-actions">
        <button class="gw-form-save">Save</button>
        <button class="gw-form-cancel">Cancel</button>
      </div>`;
      inner.appendChild(form);
      form.querySelector(".gw-form-save")?.addEventListener("click", async () => {
        const config = {};
        p.fields.forEach((f) => config[f.key] = document.getElementById(`gw-f-${f.key}`)?.value || "");
        await fetch("/api/gateway/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform, config }) });
        form.remove();
        this._load();
      });
      form.querySelector(".gw-form-cancel")?.addEventListener("click", () => form.remove());
    }
    // ── Actions ──
    async toggle(id) {
      await fetch(`/api/gateway/connections/${id}/toggle`, { method: "POST" });
      this._load();
    }
    async remove(id) {
      if (!confirm("Delete connection?")) return;
      await fetch(`/api/gateway/connections/${id}`, { method: "DELETE" });
      this._load();
    }
    async clearInbox() {
      await fetch("/api/gateway/inbox", { method: "DELETE" });
      this._inbox = [];
      this._selectedMessage = null;
      this._searchResults = null;
      this._renderInboxTab();
    }
  };
  function esc(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }
  function timeAgo(ts) {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 6e4) return "just now";
    if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
    if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
    return new Date(ts).toLocaleDateString();
  }
  function formatUptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  }
  var page = new GatewayPage();
  window._gwPage = page;
  document.body.appendChild(page.container);
  page.onEnter();
})();
