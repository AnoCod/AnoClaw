// WeChatAdapter — connects to personal WeChat via Tencent iLink Bot API.
// Outbound: HTTPS POST /ilink/bot/sendmessage
// Inbound: Long-poll HTTPS POST /ilink/bot/getupdates (35s timeout)
// No external dependencies — uses native https module.
// Credentials: token (Bearer) + accountId
// Rich messages: image (IMG), file (FILE), link card (LINK),
// mini-program (MINI_PROGRAM), emoji (EMOJI)

import * as https from 'https';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const EP_SEND = '/ilink/bot/sendmessage';
const EP_POLL = '/ilink/bot/getupdates';

const CHANNEL_VER = '2.2.0';
const APP_ID = 'bot';
const CLIENT_VER = String((2 << 16) | (2 << 8) | 0); // "131074"

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_FILE = 3;
const ITEM_LINK = 5;
const ITEM_MINI_PROGRAM = 6;
const ITEM_EMOJI = 7;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Extract text content from a WeChat message item_list */
function extractText(msg) {
  if (msg.item_list && Array.isArray(msg.item_list)) {
    for (const item of msg.item_list) {
      if (item.type === ITEM_TEXT && item.text_item) return item.text_item.text || '';
    }
  }
  return msg.content || '';
}

/** Extract rich content info from a WeChat message (image, file, link, etc.) */
function extractRichContent(msg) {
  if (!msg || !msg.item_list || !Array.isArray(msg.item_list)) return null;
  for (const item of msg.item_list) {
    if (item.type === ITEM_IMAGE && item.image_item) {
      return { media_type: 'image', media_url: item.image_item.file_url || item.image_item.file_id || '', title: item.image_item.title || '' };
    }
    if (item.type === ITEM_FILE && item.file_item) {
      return { media_type: 'file', media_url: item.file_item.file_url || item.file_item.file_id || '', title: item.file_item.title || '' };
    }
    if (item.type === ITEM_LINK && item.link_item) {
      return { media_type: 'link', media_url: item.link_item.url || '', title: item.link_item.title || '', description: item.link_item.description || '', thumb_url: item.link_item.thumb_url || '' };
    }
    if (item.type === ITEM_MINI_PROGRAM && item.miniprogram_item) {
      return { media_type: 'mini_program', media_url: item.miniprogram_item.appid || '', title: item.miniprogram_item.title || '' };
    }
    if (item.type === ITEM_EMOJI && item.emoji_item) {
      return { media_type: 'emoji', media_url: item.emoji_item.emoji_url || '', title: '' };
    }
  }
  return null;
}

export class WeChatAdapter {
  constructor(config) {
    this._token = config.token || '';
    this._accountId = config.accountId || '';
    this._baseUrl = (config.baseUrl || ILINK_BASE).replace(/\/+$/, '');
    this._contextTokens = {};   // chatId → context_token (needed for replies)
    this._syncBuf = '';         // cursor for long-poll continuation
    this._running = false;
    this._onMessage = null;
  }

  _headers(body) {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this._token}`,
      'X-WECHAT-UIN': Math.random().toString(36).slice(2, 10),
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': CLIENT_VER,
      'Content-Length': Buffer.byteLength(body),
    };
  }

  /** Low-level HTTPS POST to iLink API */
  _request(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const fixed = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
      const url = new URL(fixed, this._baseUrl);
      const opts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: this._headers(body),
        timeout: 40_000,
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
      req.on('timeout', () => { req.destroy(); reject(new Error('WeChat iLink timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── Outbound ──

  async sendMessage(chatId, content, parseMode) {
    const msg = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text: content } }],
    };
    if (this._contextTokens[chatId]) {
      msg.context_token = this._contextTokens[chatId];
    }
    const result = await this._request(EP_SEND, { msg, base_info: { channel_version: CHANNEL_VER } });
    // errcode -14 means session expired — clear the stale token
    if (result.errcode === -14) {
      delete this._contextTokens[chatId];
      throw new Error(`WeChat session expired for ${chatId}`);
    }
    if (result.ret !== 0 && result.ret !== undefined) {
      throw new Error(`WeChat send error: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg || ''}`);
    }
    return result;
  }

  // ── Rich Outbound ──

  /** Send an image message via iLink Bot API */
  async sendImage(chatId, imageUrl, title) {
    const msg = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_IMAGE, image_item: { file_url: imageUrl, title: title || '' } }],
    };
    if (this._contextTokens[chatId]) msg.context_token = this._contextTokens[chatId];
    const result = await this._request(EP_SEND, { msg, base_info: { channel_version: CHANNEL_VER } });
    if (result.errcode === -14) { delete this._contextTokens[chatId]; throw new Error(`WeChat session expired for ${chatId}`); }
    if (result.ret !== 0 && result.ret !== undefined) throw new Error(`WeChat sendImage error: ret=${result.ret} errcode=${result.errcode}`);
    return result;
  }

  /** Send a file message via iLink Bot API */
  async sendFile(chatId, fileUrl, title) {
    const msg = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_FILE, file_item: { file_url: fileUrl, title: title || '' } }],
    };
    if (this._contextTokens[chatId]) msg.context_token = this._contextTokens[chatId];
    const result = await this._request(EP_SEND, { msg, base_info: { channel_version: CHANNEL_VER } });
    if (result.errcode === -14) { delete this._contextTokens[chatId]; throw new Error(`WeChat session expired for ${chatId}`); }
    if (result.ret !== 0 && result.ret !== undefined) throw new Error(`WeChat sendFile error: ret=${result.ret} errcode=${result.errcode}`);
    return result;
  }

  /** Send a link card message (title + description + URL + thumbnail) */
  async sendLinkCard(chatId, { url, title, description, thumbUrl }) {
    const msg = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_LINK, link_item: { url, title: title || '', description: description || '', thumb_url: thumbUrl || '' } }],
    };
    if (this._contextTokens[chatId]) msg.context_token = this._contextTokens[chatId];
    const result = await this._request(EP_SEND, { msg, base_info: { channel_version: CHANNEL_VER } });
    if (result.errcode === -14) { delete this._contextTokens[chatId]; throw new Error(`WeChat session expired for ${chatId}`); }
    if (result.ret !== 0 && result.ret !== undefined) throw new Error(`WeChat sendLinkCard error: ret=${result.ret} errcode=${result.errcode}`);
    return result;
  }

  // ── Inbound (long-poll) ──

  startPolling(onMessage) {
    if (this._running) return;
    this._running = true;
    this._onMessage = onMessage;
    this._pollLoop().catch(() => {});
  }

  async _pollLoop() {
    while (this._running) {
      try {
        const result = await this._request(EP_POLL, {
          base_info: { channel_version: CHANNEL_VER },
          sync_buf: this._syncBuf,
        });
        // Update polling cursor
        if (result.sync_buf) this._syncBuf = result.sync_buf;

        // Process incoming messages
        if (result.msgs && Array.isArray(result.msgs)) {
          for (const msg of result.msgs) {
            const fromId = msg.from_user_id || '';
            const text = extractText(msg);
            const rich = extractRichContent(msg);
            if (!text && !rich) continue;
            // Store context_token for reply continuity
            if (msg.context_token) this._contextTokens[fromId] = msg.context_token;
            this._onMessage('wechat', fromId, text, { ...msg, ...rich });
          }
        }
      } catch {
        // Poll failure (timeout, network) — wait and retry
        await sleep(5000);
      }
    }
  }

  stopPolling() {
    this._running = false;
  }

  isConnected() { return !!this._token && !!this._accountId; }
  platform() { return 'wechat'; }
}
