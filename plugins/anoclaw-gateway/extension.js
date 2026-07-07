// extension.js - Gateway plugin (v2.1.0).
// Full multi-platform gateway: Telegram, WeChat (iLink Bot API, long-poll),
// Feishu (REST + WebSocket).
// Connection config stored in data/gateway_connections.json.
// Inbox messages persisted to data/inbox.json.
// Auth: API key middleware for all routes.
// Features: message dedup, health monitoring, image/file support, WebSocket real-time.

import * as https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');

import { TelegramAdapter } from './adapters/TelegramAdapter.js';
import { WeChatAdapter } from './adapters/WeChatAdapter.js';
import { FeishuAdapter } from './adapters/FeishuAdapter.js';

// ═══════════════════════════════════════════════════════════════
// Connection store
// ═══════════════════════════════════════════════════════════════

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'gateway_connections.json');
const INBOX_FILE = path.join(DATA_DIR, 'inbox.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'gateway_templates.json');
const RETRY_FILE = path.join(DATA_DIR, 'gateway_retry_queue.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch { return []; }
}

function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════════════════
// Inbox - persisted to JSON file, in-memory mirror for speed
// ═══════════════════════════════════════════════════════════════

const _inbox = [];
const INBOX_MAX = 500;

function loadInbox() {
  try {
    const data = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf-8'));
    if (Array.isArray(data)) {
      _inbox.length = 0;
      _inbox.push(...data.slice(-INBOX_MAX));
    }
  } catch { /* no inbox yet */ }
}

function persistInbox() {
  try {
    ensureDataDir();
    fs.writeFileSync(INBOX_FILE, JSON.stringify(_inbox, null, 2));
  } catch (err) {
    if (_anoclaw) _anoclaw.log.error(`Failed to persist inbox: ${err.message}`);
  }
}

function addInboxMessage(platform, chatId, senderId, text, connectionId, extra) {
  const entry = {
    platform,
    chatId,
    senderId,
    text,
    timestamp: new Date().toISOString(),
    connectionId,
    ...extra, // media_type, media_url, etc.
  };
  _inbox.push(entry);
  // Cap inbox size
  if (_inbox.length > INBOX_MAX) _inbox.splice(0, _inbox.length - INBOX_MAX);
  persistInbox();

  // Notify frontend via WebSocket
  if (typeof _anoclaw?.ws?.broadcast === 'function') {
    try { _anoclaw.ws.broadcast({ type: 'gateway:message', ...entry }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// Message Templates - reusable message formats
// ═══════════════════════════════════════════════════════════════

const _templates = [];

function loadTemplates() {
  try {
    const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
    if (Array.isArray(data)) { _templates.length = 0; _templates.push(...data); }
  } catch { /* no templates yet */ }
}

function persistTemplates() {
  try { ensureDataDir(); fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(_templates, null, 2)); }
  catch {}
}

function addTemplate({ name, platform, content, mediaType, parseMode, category }) {
  const t = {
    id: `tpl_${Date.now().toString(36)}`,
    name: name || 'Untitled',
    platform: platform || 'any',
    content: content || '',
    mediaType: mediaType || 'text',
    parseMode: parseMode || 'text',
    category: category || 'general',
    createdAt: new Date().toISOString(),
  };
  _templates.push(t);
  persistTemplates();
  return t;
}

function getTemplate(id) { return _templates.find(t => t.id === id) || null; }
function listTemplates(platform) {
  if (platform && platform !== 'any') return _templates.filter(t => t.platform === 'any' || t.platform === platform);
  return [..._templates];
}
function deleteTemplate(id) {
  const idx = _templates.findIndex(t => t.id === id);
  if (idx < 0) return false;
  _templates.splice(idx, 1);
  persistTemplates();
  return true;
}

function applyTemplate(templateId, variables) {
  const t = getTemplate(templateId);
  if (!t) return null;
  let content = t.content;
  if (variables && typeof variables === 'object') {
    for (const [key, val] of Object.entries(variables)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val));
    }
  }
  return { ...t, content };
}

// ═══════════════════════════════════════════════════════════════
// Outbound Retry Queue - exponential backoff
// ═══════════════════════════════════════════════════════════════

const _retryQueue = [];
const RETRY_MAX = 100;
const RETRY_INTERVALS = [1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000]; // 1s to 5m

function loadRetryQueue() {
  try {
    const data = JSON.parse(fs.readFileSync(RETRY_FILE, 'utf-8'));
    if (Array.isArray(data)) { _retryQueue.length = 0; _retryQueue.push(...data); }
  } catch {}
}

function persistRetryQueue() {
  try { ensureDataDir(); fs.writeFileSync(RETRY_FILE, JSON.stringify(_retryQueue, null, 2)); }
  catch {}
}

function enqueueRetry(entry) {
  const item = {
    id: `rtry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ...entry,
    attempt: 0,
    maxAttempts: RETRY_INTERVALS.length,
    status: 'pending',
    createdAt: new Date().toISOString(),
    nextRetryAt: new Date(Date.now() + RETRY_INTERVALS[0]).toISOString(),
  };
  if (_retryQueue.length >= RETRY_MAX) _retryQueue.shift(); // drop oldest
  _retryQueue.push(item);
  persistRetryQueue();
  return item;
}

async function processRetryQueue() {
  const now = Date.now();
  for (let i = _retryQueue.length - 1; i >= 0; i--) {
    const item = _retryQueue[i];
    if (item.status !== 'pending') continue;
    if (new Date(item.nextRetryAt).getTime() > now) continue;

    const adapter = getAdapter(item.platform);
    if (!adapter) {
      item.status = 'failed';
      item.lastError = `No adapter for ${item.platform}`;
      continue;
    }

    try {
      await adapter.sendMessage(item.chatId, item.content, item.parseMode);
      item.status = 'sent';
      _retryQueue.splice(i, 1);
    } catch (err) {
      item.attempt++;
      item.lastError = err.message;
      if (item.attempt >= item.maxAttempts) {
        item.status = 'failed';
      } else {
        item.nextRetryAt = new Date(now + RETRY_INTERVALS[item.attempt] || RETRY_INTERVALS[RETRY_INTERVALS.length - 1]).toISOString();
      }
    }
  }
  persistRetryQueue();
}

let _retryTimer = null;
function startRetryProcessor() {
  if (_retryTimer) return;
  _retryTimer = setInterval(() => { processRetryQueue().catch(() => {}); }, 5000);
}
function stopRetryProcessor() {
  if (_retryTimer) { clearInterval(_retryTimer); _retryTimer = null; }
}

function getRetryQueue() { return [..._retryQueue]; }
function clearRetryQueue() { _retryQueue.length = 0; persistRetryQueue(); }
function removeRetryItem(id) {
  const idx = _retryQueue.findIndex(r => r.id === id);
  if (idx < 0) return false;
  _retryQueue.splice(idx, 1);
  persistRetryQueue();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Message Search / Filter
// ═══════════════════════════════════════════════════════════════

function searchMessages({ query, platform, startDate, endDate, mediaType, limit }) {
  let results = [..._inbox];
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(m => (m.text || '').toLowerCase().includes(q) || (m.senderId || '').toLowerCase().includes(q));
  }
  if (platform) results = results.filter(m => m.platform === platform);
  if (mediaType) results = results.filter(m => m.media_type === mediaType);
  if (startDate) {
    const start = new Date(startDate).getTime();
    results = results.filter(m => new Date(m.timestamp).getTime() >= start);
  }
  if (endDate) {
    const end = new Date(endDate).getTime();
    results = results.filter(m => new Date(m.timestamp).getTime() <= end);
  }
  if (limit) results = results.slice(-limit);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Platform adapter factory - single source of truth (DRY fix)
// ═══════════════════════════════════════════════════════════════

function createAdapter(platform, config) {
  switch (platform) {
    case 'telegram': return new TelegramAdapter(config);
    case 'wechat':   return new WeChatAdapter(config);
    case 'feishu':   return new FeishuAdapter(config);
    default:         return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Adapter registry
// ═══════════════════════════════════════════════════════════════

const _adapters = {};

function onAdapterMessage(platform, chatId, text, raw) {
  const extra = {
    media_type: raw?.media_type || null,
    media_url: raw?.media_url || null,
    title: raw?.title || null,
    description: raw?.description || null,
    thumb_url: raw?.thumb_url || null,
    callback_data: raw?.callback_data || null,
    callback_query_id: raw?.callback_query_id || null,
    message_type: raw?.message_type || null,
  };
  for (const [id, adapter] of Object.entries(_adapters)) {
    if (adapter.platform() === platform) {
      addInboxMessage(platform, chatId, raw?.sender_id || chatId, text, id, extra);
      return;
    }
  }
  addInboxMessage(platform, chatId, raw?.sender_id || chatId, text, '', extra);
}

function startAdapter(conn) {
  const adapter = createAdapter(conn.platform, conn.config || {});
  if (!adapter) return null;
  adapter.startPolling(onAdapterMessage);
  return adapter;
}

function stopAdapter(adapter) {
  if (typeof adapter.stopPolling === 'function') adapter.stopPolling();
}

function initAdapters() {
  const config = loadConfig();
  for (const conn of config) {
    if (!conn.connected) continue;
    try {
      const adapter = startAdapter(conn);
      if (adapter) _adapters[conn.id] = adapter;
    } catch {}
  }
}

function getAdapter(platform) {
  for (const [id, adapter] of Object.entries(_adapters)) {
    if (adapter.platform() === platform) return adapter;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// API Key auth middleware
// ═══════════════════════════════════════════════════════════════

const API_KEY_ENV = 'GATEWAY_API_KEY';
let _apiKey = process.env[API_KEY_ENV] || '';

function setApiKey(key) { _apiKey = key; }

function requireAuth(req) {
  if (!_apiKey) return true; // No key configured = open (dev mode)
  const authHeader = req.headers?.['authorization'] || '';
  const queryKey = req.query || '';
  return authHeader === `Bearer ${_apiKey}` || queryKey.includes(`api_key=${_apiKey}`);
}

function authMiddleware(handler) {
  return async function (req) {
    if (!requireAuth(req)) {
      return { status: 401, body: { error: 'Unauthorized. Provide API key via Authorization: Bearer <key> header.' } };
    }
    return handler(req);
  };
}

// ═══════════════════════════════════════════════════════════════
// Plugin lifecycle
// ═══════════════════════════════════════════════════════════════

let _anoclaw = null;

export async function activate(anoclaw) {
  _anoclaw = anoclaw;
  anoclaw.log.info('Gateway plugin activating');

  ensureDataDir();
  loadInbox();
  loadTemplates();
  loadRetryQueue();
  initAdapters();
  startRetryProcessor();

  // Load API key from environment or settings
  if (!process.env[API_KEY_ENV]) {
    try {
      const data = await anoclaw.memory?.list({ scope: 'team', limit: 10 }) || [];
      const keyEntry = data.find(e => e.name === 'gateway-api-key');
      if (keyEntry) {
        try { _apiKey = JSON.parse(keyEntry.content); } catch { _apiKey = keyEntry.content; }
      }
    } catch {}
  }

  // Register HTTP routes (all wrapped with auth)
  await anoclaw.routes.register([
    { method: 'GET',    path: '/api/gateway/connections',         handler: 'handleListConnections' },
    { method: 'POST',   path: '/api/gateway/connections',         handler: 'handleCreateConnection' },
    { method: 'DELETE', path: '/api/gateway/connections/:id',     handler: 'handleDeleteConnection' },
    { method: 'POST',   path: '/api/gateway/connections/:id/toggle', handler: 'handleToggleConnection' },
    { method: 'GET',    path: '/api/gateway/inbox',               handler: 'handleListInbox' },
    { method: 'DELETE', path: '/api/gateway/inbox',               handler: 'handleClearInbox' },
    { method: 'GET',    path: '/api/gateway/health',              handler: 'handleHealth' },
    { method: 'POST',   path: '/api/gateway/send',               handler: 'handleSend' },
    { method: 'GET',    path: '/api/gateway/search',              handler: 'handleSearch' },
    { method: 'GET',    path: '/api/gateway/templates',           handler: 'handleListTemplates' },
    { method: 'POST',   path: '/api/gateway/templates',           handler: 'handleCreateTemplate' },
    { method: 'DELETE', path: '/api/gateway/templates/:id',       handler: 'handleDeleteTemplate' },
    { method: 'POST',   path: '/api/gateway/templates/:id/apply', handler: 'handleApplyTemplate' },
    { method: 'GET',    path: '/api/gateway/retry-queue',         handler: 'handleRetryQueue' },
    { method: 'DELETE', path: '/api/gateway/retry-queue',         handler: 'handleClearRetryQueue' },
    { method: 'DELETE', path: '/api/gateway/retry-queue/:id',     handler: 'handleRemoveRetryItem' },
    { method: 'POST',   path: '/api/gateway/telegram/webhook',    handler: 'handleTelegramWebhook' },
    { method: 'POST',   path: '/api/gateway/telegram/webhook/setup', handler: 'handleTelegramWebhookSetup' },
  ]);

  // Register tools
  await anoclaw.tools.register({
    name: 'GatewaySend',
    description: 'Send a message to an external messaging platform. Supports text, images, documents, files, link cards, and interactive cards. Works with Telegram (text, sendPhoto, sendDocument, inline keyboard), WeChat (text, image, file, link card), Feishu (text, rich text, interactive card, image, file).',
    parametersSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Target platform: "telegram", "wechat", "feishu".' },
        chatId: { type: 'string', description: 'Target chat/channel/user ID.' },
        content: { type: 'string', description: 'Message content (text for text, URL for image/document/card JSON).' },
        parseMode: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Format. Default: text.' },
        mediaType: { type: 'string', enum: ['text', 'photo', 'document', 'image', 'file', 'link_card', 'card', 'rich_text'], description: 'Media/content type. Default: text.' },
        title: { type: 'string', description: 'Title for link cards or file messages.' },
        description: { type: 'string', description: 'Description for link cards.' },
        thumbUrl: { type: 'string', description: 'Thumbnail URL for link cards.' },
        buttons: { type: 'array', description: 'Inline keyboard buttons for Telegram (array of rows).' },
        templateId: { type: 'string', description: 'Optional template ID to apply before sending.' },
        variables: { type: 'object', description: 'Template variables (key-value pairs).' },
        retry: { type: 'boolean', description: 'If true, enqueue with retry on failure. Default: false.' },
      },
      required: ['platform', 'chatId', 'content'],
    },
    category: 'Integration',
  });

  await anoclaw.tools.register({
    name: 'GatewaySearchMessages',
    description: 'Search and filter inbound messages by text query, platform, date range, or media type.',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text search query (matches message text and sender ID).' },
        platform: { type: 'string', enum: ['telegram', 'wechat', 'feishu'], description: 'Filter by platform.' },
        startDate: { type: 'string', description: 'Start date filter (ISO format).' },
        endDate: { type: 'string', description: 'End date filter (ISO format).' },
        mediaType: { type: 'string', description: 'Filter by media type (photo, document, image, file, etc.).' },
        limit: { type: 'number', description: 'Max results to return. Default: 50.' },
      },
      required: [],
    },
    category: 'Integration',
  });

  await anoclaw.tools.register({
    name: 'GatewayTemplates',
    description: 'Manage message templates. List, create, delete, or apply templates with variable substitution ({{variable}} syntax).',
    parametersSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete', 'apply'], description: 'Action to perform.' },
        templateId: { type: 'string', description: 'Template ID (for delete/apply).' },
        name: { type: 'string', description: 'Template name (for create).' },
        platform: { type: 'string', description: 'Target platform for template.' },
        content: { type: 'string', description: 'Template content with {{variable}} placeholders.' },
        mediaType: { type: 'string', description: 'Media type for template.' },
        category: { type: 'string', description: 'Template category.' },
        variables: { type: 'object', description: 'Variables to substitute (for apply).' },
      },
      required: ['action'],
    },
    category: 'Integration',
  });

  await anoclaw.tools.register({
    name: 'GatewayStatus',
    description: 'Check connection status of gateway platform adapters. Returns health info including uptime, error count, last message time.',
    parametersSchema: { type: 'object', properties: {}, required: [] },
    category: 'Integration',
  });

  await anoclaw.tools.register({
    name: 'GatewayReadInbox',
    description: 'Read all pending inbound messages received from gateway platforms. Clears the inbox after reading.',
    parametersSchema: { type: 'object', properties: {}, required: [] },
    category: 'Integration',
  });

  // Inject prompt section for agent awareness
  await anoclaw.prompt.inject('gateway-rules',
    '## Gateway Rules\n' +
    '- Gateway tools can send or read external messages. Treat outbound messages as user-visible external side effects.\n' +
    '- Use GatewayReadInbox for pending inbound messages and GatewaySearchMessages for filtered history.\n' +
    '- Use GatewayStatus before troubleshooting delivery or adapter behavior.\n' +
    '- Use GatewayTemplates for reusable message formats with {{variable}} substitution.\n' +
    '- For images, documents, files, link cards, or cards, set mediaType and provide the required URL/title/card fields.\n' +
    '- Set retry: true only when duplicate delivery is acceptable.\n' +
    '- Confirm ambiguous or high-impact outbound messages before sending unless the user has already authorized the exact content and recipient.\n',
    40
  );

  anoclaw.log.info('Gateway plugin activated - all adapters initialized');

  await mountSlotBadge(
    anoclaw,
    'Gateway',
    `${loadConfig().length} conn / ${_inbox.length} inbox`,
    _inbox.length > 0 ? 'info' : 'ok',
    'gateway-status',
    60,
  );

  return [{ dispose() {
    for (const adapter of Object.values(_adapters)) {
      if (typeof adapter.stopPolling === 'function') adapter.stopPolling();
    }
    stopRetryProcessor();
    persistInbox();
    persistTemplates();
    persistRetryQueue();
    anoclaw.ui?.unmountAll('titlebar-right').catch(() => {});
    anoclaw.log.info('Gateway plugin deactivated');
  } }];
}

async function mountSlotBadge(anoclaw, label, value, tone, id, priority = 50) {
  const html = `<span class="anoclaw-slot-pill" data-tone="${tone}"><span class="slot-dot"></span><strong>${escapeSlot(label)}</strong><span>${escapeSlot(value)}</span></span>`;
  await anoclaw.ui?.mount('titlebar-right', html, { id, priority, position: 'append', replace: true });
}

function escapeSlot(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
// HTTP route handlers (all with auth)
// ═══════════════════════════════════════════════════════════════

export const handleListConnections = authMiddleware(async (_req) => {
  return { status: 200, body: { connections: loadConfig() } };
});

export const handleCreateConnection = authMiddleware(async (req) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const config = loadConfig();
  const id = body.id || `gw_${Date.now().toString(36)}`;
  const entry = {
    id,
    name: body.name || id,
    platform: body.platform || 'telegram',
    config: body.config || {},
    connected: false,
    createdAt: new Date().toISOString(),
  };
  config.push(entry);
  saveConfig(config);
  return { status: 201, body: entry };
});

export const handleDeleteConnection = authMiddleware(async (req) => {
  const id = req.params?.id || (req.path || '').split('/').pop();
  if (_adapters[id]) {
    stopAdapter(_adapters[id]);
    delete _adapters[id];
  }
  const config = loadConfig();
  const idx = config.findIndex(c => c.id === id);
  if (idx < 0) return { status: 404, body: { error: 'Not found' } };
  config.splice(idx, 1);
  saveConfig(config);
  return { status: 200, body: { deleted: true, id } };
});

export const handleToggleConnection = authMiddleware(async (req) => {
  const id = req.params?.id || (req.path || '').split('/connections/')[1]?.split('/')[0];
  const config = loadConfig();
  const item = config.find(c => c.id === id);
  if (!item) return { status: 404, body: { error: 'Not found' } };
  item.connected = !item.connected;
  saveConfig(config);

  if (item.connected) {
    if (_adapters[id]) { stopAdapter(_adapters[id]); delete _adapters[id]; }
    const adapter = startAdapter(item);
    if (adapter) _adapters[id] = adapter;
  } else {
    if (_adapters[id]) {
      stopAdapter(_adapters[id]);
      delete _adapters[id];
    }
  }
  return { status: 200, body: { id, connected: item.connected } };
});

export const handleListInbox = authMiddleware(async (_req) => {
  return { status: 200, body: { messages: _inbox.slice() } };
});

export const handleClearInbox = authMiddleware(async (_req) => {
  const count = _inbox.length;
  _inbox.length = 0;
  persistInbox();
  return { status: 200, body: { cleared: count } };
});

export const handleHealth = authMiddleware(async (_req) => {
  const statuses = {};
  for (const [id, adapter] of Object.entries(_adapters)) {
    const health = typeof adapter.getHealth === 'function' ? adapter.getHealth() : {};
    statuses[id] = {
      platform: adapter.platform(),
      connected: adapter.isConnected(),
      ...health,
    };
  }
  return {
    status: 200,
    body: {
      uptime: Math.floor(process.uptime()),
      adapterCount: Object.keys(_adapters).length,
      adapters: statuses,
      inboxSize: _inbox.length,
    },
  };
});

export const handleSend = authMiddleware(async (req) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { platform, chatId, content, mediaType, title, description, thumbUrl, buttons, templateId, variables, retry } = body;

  // Apply template if provided
  let finalContent = content;
  let finalMediaType = mediaType;
  if (templateId) {
    const applied = applyTemplate(templateId, variables);
    if (applied) {
      finalContent = applied.content;
      if (!mediaType) finalMediaType = applied.mediaType;
    }
  }

  const adapter = getAdapter(platform);
  if (!adapter) return { status: 404, body: { error: `No adapter for ${platform}` } };

  try {
    let result;
    if (platform === 'telegram') {
      if (buttons && Array.isArray(buttons)) {
        result = await adapter.sendMessageWithInlineKeyboard(chatId, finalContent, buttons, body.parseMode);
      } else if (mediaType === 'photo') {
        result = await adapter.sendPhoto(chatId, finalContent, body.caption);
      } else if (mediaType === 'document') {
        result = await adapter.sendDocument(chatId, finalContent, body.caption);
      } else {
        result = await adapter.sendMessage(chatId, finalContent, body.parseMode);
      }
    } else if (platform === 'wechat') {
      if (mediaType === 'image') {
        result = await adapter.sendImage(chatId, finalContent, title);
      } else if (mediaType === 'file') {
        result = await adapter.sendFile(chatId, finalContent, title);
      } else if (mediaType === 'link_card') {
        result = await adapter.sendLinkCard(chatId, { url: finalContent, title, description, thumbUrl });
      } else {
        result = await adapter.sendMessage(chatId, finalContent, body.parseMode);
      }
    } else if (platform === 'feishu') {
      if (mediaType === 'card') {
        result = await adapter.sendCardMessage(chatId, finalContent);
      } else if (mediaType === 'rich_text') {
        result = await adapter.sendRichText(chatId, JSON.parse(finalContent));
      } else if (mediaType === 'image') {
        result = await adapter.sendImage(chatId, finalContent);
      } else if (mediaType === 'file') {
        result = await adapter.sendFile(chatId, finalContent, title);
      } else {
        result = await adapter.sendMessage(chatId, finalContent, body.parseMode);
      }
    }
    return { status: 200, body: { sent: true, platform, chatId } };
  } catch (err) {
    if (retry) {
      const item = enqueueRetry({ platform, chatId, content: finalContent, parseMode: body.parseMode });
      return { status: 202, body: { queued: true, retryId: item.id, error: err.message } };
    }
    return { status: 500, body: { error: err.message } };
  }
});

export const handleSearch = authMiddleware(async (req) => {
  const query = req.query || '';
  const params = {};
  // Parse query string params
  const searchParams = new URLSearchParams(query);
  if (searchParams.has('q')) params.query = searchParams.get('q');
  if (searchParams.has('platform')) params.platform = searchParams.get('platform');
  if (searchParams.has('startDate')) params.startDate = searchParams.get('startDate');
  if (searchParams.has('endDate')) params.endDate = searchParams.get('endDate');
  if (searchParams.has('mediaType')) params.mediaType = searchParams.get('mediaType');
  if (searchParams.has('limit')) params.limit = parseInt(searchParams.get('limit')) || 50;
  const results = searchMessages(params);
  return { status: 200, body: { messages: results, count: results.length } };
});

export const handleListTemplates = authMiddleware(async (req) => {
  const query = req.query || '';
  const searchParams = new URLSearchParams(query);
  const platform = searchParams.get('platform') || undefined;
  return { status: 200, body: { templates: listTemplates(platform) } };
});

export const handleCreateTemplate = authMiddleware(async (req) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const t = addTemplate(body);
  return { status: 201, body: t };
});

export const handleDeleteTemplate = authMiddleware(async (req) => {
  const id = req.params?.id || (req.path || '').split('/').pop();
  if (deleteTemplate(id)) return { status: 200, body: { deleted: true, id } };
  return { status: 404, body: { error: 'Template not found' } };
});

export const handleApplyTemplate = authMiddleware(async (req) => {
  const id = req.params?.id || (req.path || '').split('/templates/')[1]?.split('/')[0];
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const applied = applyTemplate(id, body.variables);
  if (!applied) return { status: 404, body: { error: 'Template not found' } };
  return { status: 200, body: applied };
});

export const handleRetryQueue = authMiddleware(async (_req) => {
  return { status: 200, body: { queue: getRetryQueue(), count: getRetryQueue().length } };
});

export const handleClearRetryQueue = authMiddleware(async (_req) => {
  const count = getRetryQueue().length;
  clearRetryQueue();
  return { status: 200, body: { cleared: count } };
});

export const handleRemoveRetryItem = authMiddleware(async (req) => {
  const id = req.params?.id || (req.path || '').split('/').pop();
  if (removeRetryItem(id)) return { status: 200, body: { removed: true, id } };
  return { status: 404, body: { error: 'Retry item not found' } };
});

export const handleTelegramWebhook = authMiddleware(async (req) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const adapter = getAdapter('telegram');
  if (!adapter) return { status: 503, body: { error: 'No Telegram adapter connected' } };
  try {
    adapter.processWebhookUpdate(body);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
});

export const handleTelegramWebhookSetup = authMiddleware(async (req) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const adapter = getAdapter('telegram');
  if (!adapter) return { status: 404, body: { error: 'No Telegram adapter found' } };
  try {
    if (body.remove) {
      await adapter.removeWebhook();
      return { status: 200, body: { removed: true } };
    }
    await adapter.setWebhook(body.url, body.secretToken);
    const info = await adapter.getWebhookInfo();
    return { status: 200, body: { set: true, webhookInfo: info } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
});

// ═══════════════════════════════════════════════════════════════
// Tool execution - called by the agent
// ═══════════════════════════════════════════════════════════════

export async function executeTool(toolName, params) {
  switch (toolName) {
    case 'GatewaySend': {
      const adapter = getAdapter(params.platform);
      if (!adapter) {
        return `Error: No connected adapter for platform "${params.platform}". Configure one in the Gateway page.`;
      }

      // Apply template if provided
      let content = params.content;
      if (params.templateId) {
        const applied = applyTemplate(params.templateId, params.variables);
        if (applied) content = applied.content;
      }

      try {
        const mediaType = params.mediaType || 'text';
        if (params.platform === 'telegram') {
          if (params.buttons && Array.isArray(params.buttons)) {
            await adapter.sendMessageWithInlineKeyboard(params.chatId, content, params.buttons, params.parseMode);
            return `Message with inline keyboard sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'photo') {
            await adapter.sendPhoto(params.chatId, content, params.caption || '');
            return `Photo sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'document') {
            await adapter.sendDocument(params.chatId, content, params.caption || '');
            return `Document sent to ${params.platform} (chatId: ${params.chatId})`;
          }
        } else if (params.platform === 'wechat') {
          if (mediaType === 'image') {
            await adapter.sendImage(params.chatId, content, params.title || '');
            return `Image sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'file') {
            await adapter.sendFile(params.chatId, content, params.title || '');
            return `File sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'link_card') {
            await adapter.sendLinkCard(params.chatId, { url: content, title: params.title, description: params.description, thumbUrl: params.thumbUrl });
            return `Link card sent to ${params.platform} (chatId: ${params.chatId})`;
          }
        } else if (params.platform === 'feishu') {
          if (mediaType === 'card') {
            await adapter.sendCardMessage(params.chatId, content);
            return `Card sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'rich_text') {
            await adapter.sendRichText(params.chatId, JSON.parse(content));
            return `Rich text sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'image') {
            await adapter.sendImage(params.chatId, content);
            return `Image sent to ${params.platform} (chatId: ${params.chatId})`;
          } else if (mediaType === 'file') {
            await adapter.sendFile(params.chatId, content, params.title || '');
            return `File sent to ${params.platform} (chatId: ${params.chatId})`;
          }
        }

        await adapter.sendMessage(params.chatId, content, params.parseMode || 'text');
        return `Message sent to ${params.platform} (chatId: ${params.chatId})`;
      } catch (err) {
        if (params.retry) {
          const item = enqueueRetry({ platform: params.platform, chatId: params.chatId, content, parseMode: params.parseMode });
          return `Message queued for retry (id: ${item.id}). Error: ${err.message}`;
        }
        return `Error sending message: ${err.message}`;
      }
    }
    case 'GatewaySearchMessages': {
      const results = searchMessages(params);
      if (results.length === 0) return 'No messages match the search criteria.';
      return results.map(m => {
        let line = `[${m.platform}] ${m.senderId}: ${m.text} (${m.timestamp})`;
        if (m.media_type) line += ` [${m.media_type}]`;
        return line;
      }).join('\n---\n');
    }
    case 'GatewayTemplates': {
      switch (params.action) {
        case 'list': {
          const templates = listTemplates(params.platform);
          if (templates.length === 0) return 'No templates configured.';
          return templates.map(t => `${t.id}: ${t.name} (${t.platform}, ${t.category})`).join('\n');
        }
        case 'create': {
          const t = addTemplate(params);
          return `Template created: ${t.id} - ${t.name}`;
        }
        case 'delete': {
          if (deleteTemplate(params.templateId)) return `Template ${params.templateId} deleted.`;
          return `Template ${params.templateId} not found.`;
        }
        case 'apply': {
          const applied = applyTemplate(params.templateId, params.variables);
          if (!applied) return `Template ${params.templateId} not found.`;
          return `Applied template "${applied.name}":\n${applied.content}`;
        }
        default:
          return 'Unknown template action. Use: list, create, delete, apply.';
      }
    }
    case 'GatewayStatus': {
      const config = loadConfig();
      const statuses = config.map(c => {
        const adapter = _adapters[c.id];
        const health = typeof adapter?.getHealth === 'function' ? adapter.getHealth() : {};
        const status = adapter?.isConnected() ? 'connected' : 'disconnected';
        const extras = [];
        if (health.totalReceived) extras.push(`${health.totalReceived} msgs`);
        if (health.totalErrors) extras.push(`${health.totalErrors} errors`);
        if (health.uptime) extras.push(`up ${health.uptime}s`);
        const suffix = extras.length ? ` (${extras.join(', ')})` : '';
        return `${c.name || c.id}: ${c.platform} - ${status}${suffix}`;
      });
      return statuses.length > 0 ? statuses.join('\n') : 'No gateway connections configured.';
    }
    case 'GatewayReadInbox': {
      const messages = _inbox.splice(0, _inbox.length);
      persistInbox();
      if (messages.length === 0) return 'No pending messages.';
      return messages.map(m => {
        let line = `[${m.platform}] ${m.senderId}: ${m.text} (${m.timestamp})`;
        if (m.media_type && m.media_type !== 'text') line += ` [${m.media_type}: ${m.media_url}]`;
        return line;
      }).join('\n---\n');
    }
    default:
      throw new Error(`Unknown Gateway tool: ${toolName}`);
  }
}
