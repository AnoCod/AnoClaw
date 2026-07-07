// FeishuAdapter - connects to Feishu/Lark via official REST API.
// Outbound: HTTPS POST /open-apis/im/v1/messages (text, rich_text, interactive cards)
// Inbound: WebSocket wss://open.feishu.cn/ws/v1/events (ws package optional)
// Auth: appId + appSecret -> tenant_access_token (2h expiry, auto-refresh)
// Rich messages: text, rich_text, interactive (card), post (rich post), image, file
// Features: health monitoring, card templates, message actions

import * as https from 'https';

const FEISHU_BASE = 'https://open.feishu.cn';

export class FeishuAdapter {
  constructor(config) {
    this._appId = config.appId || '';
    this._appSecret = config.appSecret || '';
    this._baseUrl = FEISHU_BASE;
    this._token = null;
    this._tokenExpiry = 0;
    this._ws = null;
    this._running = false;
    this._onMessage = null;

    // Health monitoring
    this._health = {
      connected: false,
      lastMessageAt: null,
      totalReceived: 0,
      totalErrors: 0,
      lastError: null,
      startedAt: null,
    };
  }

  // ── Auth ──

  async _ensureToken() {
    if (this._token && Date.now() < this._tokenExpiry - 60_000) return this._token;
    const result = await this._request(
      '/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: this._appId, app_secret: this._appSecret },
      null, // no auth header
    );
    if (result.code !== 0) throw new Error(`Feishu auth failed: ${result.msg} (code=${result.code})`);
    this._token = result.tenant_access_token;
    this._tokenExpiry = Date.now() + (result.expire || 7200) * 1000;
    return this._token;
  }

  // ── Low-level HTTP ──

  _request(endpoint, body, token) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this._baseUrl);
      const payload = JSON.stringify(body);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const opts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers,
        timeout: 15_000,
      };
      const req = https.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Feishu API timeout')); });
      req.write(payload);
      req.end();
    });
  }

  // ── Outbound ──

  async sendMessage(chatId, content, parseMode) {
    const token = await this._ensureToken();
    const msgContent = JSON.stringify({ text: content });
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'text', content: msgContent },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu send error: ${result.msg} (code=${result.code})`);
    return result;
  }

  // ── Rich Outbound ──

  /** Send an interactive card message (template or raw JSON) */
  async sendCardMessage(chatId, card) {
    const token = await this._ensureToken();
    const cardContent = typeof card === 'string' ? card : JSON.stringify(card);
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'interactive', content: cardContent },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu sendCard error: ${result.msg} (code=${result.code})`);
    return result;
  }

  /** Send a rich text (post) message with mixed content */
  async sendRichText(chatId, { title, content }) {
    const token = await this._ensureToken();
    const postContent = JSON.stringify({
      zh_cn: { title: title || '', content: content || [] },
    });
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'post', content: postContent },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu sendRichText error: ${result.msg} (code=${result.code})`);
    return result;
  }

  /** Send a predefined card template (e.g., notification, alert, summary) */
  async sendCardTemplate(chatId, templateId, templateVariables) {
    const token = await this._ensureToken();
    const card = {
      type: 'template',
      data: {
        template_id: templateId,
        template_variable: templateVariables || {},
      },
    };
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu sendCardTemplate error: ${result.msg} (code=${result.code})`);
    return result;
  }

  /** Send an image message (using image_key from upload) */
  async sendImage(chatId, imageKey) {
    const token = await this._ensureToken();
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu sendImage error: ${result.msg} (code=${result.code})`);
    return result;
  }

  /** Send a file message (using file_key from upload) */
  async sendFile(chatId, fileKey, fileName) {
    const token = await this._ensureToken();
    const result = await this._request(
      '/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey, file_name: fileName || '' }) },
      token,
    );
    if (result.code !== 0) throw new Error(`Feishu sendFile error: ${result.msg} (code=${result.code})`);
    return result;
  }

  // ── Inbound (WebSocket) ──

  async startPolling(onMessage) {
    if (this._running) return;
    this._running = true;
    this._onMessage = onMessage;
    this._health.startedAt = new Date().toISOString();
    this._health.connected = true;
    this._connectWS();
  }

  async _connectWS() {
    let ws;
    try {
      const wsMod = await import('ws');
      const WebSocket = wsMod.default || wsMod;
      const token = await this._ensureToken();
      const tokenEnc = encodeURIComponent(token);
      const wsUrl = this._baseUrl.replace('https://', 'wss://') + '/ws/v1/events?token=' + tokenEnc;
      ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.on('open', () => {
        // Connected - events will start flowing
      });

      ws.on('message', data => {
        try {
          const frame = JSON.parse(data.toString());
          // Ignore non-event messages (pong, ack, etc.)
          if (!frame.event || !frame.header) return;
          if (frame.header.event_type !== 'im.message.receive_v1') return;

          const evt = frame.event;
          const msg = evt.message || {};
          const chatId = msg.chat_id || '';
          const sender = evt.sender || {};
          const senderId = (sender.sender_id && sender.sender_id.open_id) || '';
          const content = parseFeishuContent(msg);
          const richInfo = parseFeishuRichContent(msg);
          if ((content || richInfo) && senderId) {
            this._health.totalReceived++;
            this._health.lastMessageAt = new Date().toISOString();
            this._onMessage('feishu', chatId, content, {
              sender_id: senderId,
              message_id: msg.message_id,
              message_type: msg.message_type,
              ...richInfo,
            });
          }
        } catch { /* malformed frame - skip */ }
      });

      ws.on('close', () => {
        this._ws = null;
        if (this._running) {
          // Auto-reconnect after 5s
          setTimeout(() => this._connectWS(), 5000);
        }
      });

      ws.on('error', () => {
        ws.close();
      });
    } catch (err) {
      // ws package not available in plugin context - fall back to send-only
      this._ws = null;
    }
  }

  stopPolling() {
    this._running = false;
    this._health.connected = false;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  // ── Health ──

  isConnected() { return !!this._appId && !!this._appSecret; }
  platform() { return 'feishu'; }

  getHealth() {
    return {
      ...this._health,
      uptime: this._health.startedAt
        ? Math.floor((Date.now() - new Date(this._health.startedAt).getTime()) / 1000)
        : 0,
    };
  }
}

function parseFeishuContent(msg) {
  if (!msg || !msg.content) return '';
  try {
    const parsed = JSON.parse(msg.content);
    return parsed.text || '';
  } catch { return ''; }
}

/** Extract rich content metadata from Feishu messages (image, file, audio, video, etc.) */
function parseFeishuRichContent(msg) {
  if (!msg || !msg.content) return null;
  try {
    const parsed = JSON.parse(msg.content);
    const msgType = msg.message_type || '';
    if (msgType === 'image' && parsed.image_key) {
      return { media_type: 'image', media_url: parsed.image_key };
    }
    if (msgType === 'file' && parsed.file_key) {
      return { media_type: 'file', media_url: parsed.file_key, title: parsed.file_name || '' };
    }
    if (msgType === 'audio' && parsed.file_key) {
      return { media_type: 'audio', media_url: parsed.file_key };
    }
    if (msgType === 'video' && parsed.file_key) {
      return { media_type: 'video', media_url: parsed.file_key };
    }
    if (msgType === 'sticker' && parsed.file_key) {
      return { media_type: 'sticker', media_url: parsed.file_key };
    }
    if (msgType === 'interactive') {
      return { media_type: 'card', raw_card: parsed };
    }
  } catch { /* not JSON content */ }
  return null;
}
