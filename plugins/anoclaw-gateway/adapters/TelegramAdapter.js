// TelegramAdapter — connects to Telegram Bot API via long-polling or webhook.
// Outbound: HTTPS POST /bot<token>/<method> (sendMessage, sendPhoto, sendDocument, sendInlineKeyboard)
// Inbound: Long-poll GET /bot<token>/getUpdates (30s timeout) OR webhook POST
// Supports: text, images, documents, stickers, audio, video, inline keyboards, callback queries
// Features: message deduplication, health monitoring, allowed-user filtering, webhook mode

import * as https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════════
// Deduplication cache — prevents processing the same update twice
// ═══════════════════════════════════════════════════════════════

const DEDUP_MAX = 1000;

export class TelegramAdapter {
  constructor(config) {
    this._token = config.botToken;
    this._allowedUsers = (config.allowedUserIds || '').split(',').map(s => s.trim()).filter(Boolean);
    this._running = false;
    this._offset = 0;
    this._onMessage = null;

    // Deduplication
    this._seenUpdateIds = new Set();

    // Health monitoring
    this._health = {
      connected: false,
      lastMessageAt: null,
      totalReceived: 0,
      totalErrors: 0,
      lastError: null,
      uptime: null,
      startedAt: null,
    };
  }

  // ── HTTP helpers ──────────────────────────────────────────

  _api(method, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/bot${this._token}/${method}`);
      const payload = JSON.stringify(body);
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 15000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram API timeout')); });
      req.write(payload);
      req.end();
    });
  }

  _apiGet(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/bot${this._token}/${method}`);
      const req = https.get(url, { timeout: timeoutMs || 35000 }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram poll timeout')); });
    });
  }

  // ── Outbound ──────────────────────────────────────────────

  async sendMessage(chatId, content, parseMode) {
    const result = await this._api('sendMessage', {
      chat_id: chatId,
      text: content,
      parse_mode: parseMode || 'text',
    });
    if (!result.ok) throw new Error(`Telegram error: ${result.description}`);
    return result;
  }

  async sendPhoto(chatId, photoUrl, caption) {
    const params = { chat_id: chatId, photo: photoUrl };
    if (caption) params.caption = caption;
    const result = await this._api('sendPhoto', params);
    if (!result.ok) throw new Error(`Telegram sendPhoto error: ${result.description}`);
    return result;
  }

  async sendDocument(chatId, documentUrl, caption) {
    const params = { chat_id: chatId, document: documentUrl };
    if (caption) params.caption = caption;
    const result = await this._api('sendDocument', params);
    if (!result.ok) throw new Error(`Telegram sendDocument error: ${result.description}`);
    return result;
  }

  /** Send a message with inline keyboard buttons (quick reply buttons) */
  async sendMessageWithInlineKeyboard(chatId, text, buttons, parseMode) {
    // buttons: [[{ text: 'Label', callback_data: 'data' }, ...], ...] (array of rows)
    const params = {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: buttons },
    };
    if (parseMode) params.parse_mode = parseMode;
    const result = await this._api('sendMessage', params);
    if (!result.ok) throw new Error(`Telegram inline keyboard error: ${result.description}`);
    return result;
  }

  /** Send a message with quick reply keyboard */
  async sendMessageWithReplyKeyboard(chatId, text, buttons, options) {
    // buttons: [['Button1', 'Button2'], ...] or [[{ text: 'Button1' }, ...]]
    const keyboard = buttons.map(row =>
      row.map(btn => typeof btn === 'string' ? { text: btn } : btn)
    );
    const params = {
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard,
        one_time_keyboard: options?.oneTime || false,
        resize_keyboard: options?.resize || true,
        selective: options?.selective || false,
      },
    };
    if (parseMode) params.parse_mode = parseMode;
    const result = await this._api('sendMessage', params);
    if (!result.ok) throw new Error(`Telegram reply keyboard error: ${result.description}`);
    return result;
  }

  /** Answer a callback query (from inline keyboard button press) */
  async answerCallbackQuery(callbackQueryId, text) {
    const params = { callback_query_id: callbackQueryId };
    if (text) params.text = text;
    const result = await this._api('answerCallbackQuery', params);
    if (!result.ok) throw new Error(`Telegram answerCallbackQuery error: ${result.description}`);
    return result;
  }

  /** Edit a message's inline keyboard */
  async editMessageReplyKeyboard(chatId, messageId, buttons) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons || [] },
    };
    const result = await this._api('editMessageReplyMarkup', params);
    if (!result.ok) throw new Error(`Telegram editMessageReplyMarkup error: ${result.description}`);
    return result;
  }

  // ── Webhook Support ──

  /** Set a webhook URL for the bot (more efficient than long-polling) */
  async setWebhook(url, secretToken) {
    const params = {
      url,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    };
    if (secretToken) params.secret_token = secretToken;
    const result = await this._api('setWebhook', params);
    if (!result.ok) throw new Error(`Telegram setWebhook error: ${result.description}`);
    return result;
  }

  /** Remove the webhook (switch back to long-polling) */
  async removeWebhook() {
    const result = await this._api('setWebhook', { url: '' });
    if (!result.ok) throw new Error(`Telegram removeWebhook error: ${result.description}`);
    return result;
  }

  /** Get current webhook info */
  async getWebhookInfo() {
    const result = await this._apiGet('getWebhookInfo');
    if (!result.ok) throw new Error(`Telegram getWebhookInfo error: ${result.description}`);
    return result.result;
  }

  /** Process a webhook update (called when a POST arrives at the webhook endpoint) */
  processWebhookUpdate(update) {
    if (!update) return;
    const updateId = update.update_id;

    // Deduplication
    if (this._seenUpdateIds.has(updateId)) return;
    this._seenUpdateIds.add(updateId);
    if (this._seenUpdateIds.size > DEDUP_MAX) {
      const ids = [...this._seenUpdateIds].sort((a, b) => a - b);
      const toRemove = ids.slice(0, Math.floor(ids.length / 2));
      for (const id of toRemove) this._seenUpdateIds.delete(id);
    }

    // Handle message updates
    const msg = update.message || update.edited_message;
    if (msg) {
      const chatId = String(msg.chat?.id || '');
      const from = msg.from?.username || String(msg.from?.id || '');

      if (this._allowedUsers.length > 0 && !this._allowedUsers.includes(String(msg.from?.id))) return;

      let text = msg.text || msg.caption || '';
      let mediaUrl = null;
      let mediaType = null;

      if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        mediaUrl = largest.file_id;
        mediaType = 'photo';
      } else if (msg.document) {
        mediaUrl = msg.document.file_id;
        mediaType = 'document';
      } else if (msg.sticker) {
        mediaType = 'sticker';
        text = msg.sticker.emoji || '[sticker]';
      } else if (msg.audio) {
        mediaType = 'audio';
        text = msg.audio.title || msg.audio.file_name || '[audio]';
      } else if (msg.video) {
        mediaType = 'video';
        text = msg.video.file_name || '[video]';
      }

      if (chatId && (text || mediaType)) {
        this._health.totalReceived++;
        this._health.lastMessageAt = new Date().toISOString();
        this._onMessage('telegram', chatId, text, {
          sender_id: from,
          message_id: msg.message_id,
          chat: msg.chat,
          media_type: mediaType,
          media_url: mediaUrl,
        });
      }
    }

    // Handle callback_query (inline keyboard button press)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message?.chat?.id || cb.from?.id || '');
      const text = `[callback] ${cb.data || ''}`;
      if (chatId) {
        this._health.totalReceived++;
        this._health.lastMessageAt = new Date().toISOString();
        this._onMessage('telegram', chatId, text, {
          sender_id: cb.from?.username || String(cb.from?.id || ''),
          callback_query_id: cb.id,
          callback_data: cb.data,
          message_id: cb.message?.message_id,
          chat: cb.message?.chat,
        });
      }
    }
  }

  // ── Inbound (long-poll getUpdates) ────────────────────────

  startPolling(onMessage) {
    if (this._running) return;
    this._running = true;
    this._onMessage = onMessage;
    this._health.startedAt = new Date().toISOString();
    this._health.connected = true;
    this._pollLoop().catch(() => {});
  }

  async _pollLoop() {
    while (this._running) {
      try {
        const params = `getUpdates?timeout=30&allowed_updates=["message","callback_query"]${this._offset ? '&offset=' + this._offset : ''}`;
        const result = await this._apiGet(params, 35000);
        if (!result.ok || !Array.isArray(result.result)) continue;

        for (const update of result.result) {
          const updateId = update.update_id;

          // Deduplication: skip already-processed updates
          if (this._seenUpdateIds.has(updateId)) continue;
          this._seenUpdateIds.add(updateId);

          // Prune dedup cache to prevent memory leak
          if (this._seenUpdateIds.size > DEDUP_MAX) {
            const ids = [...this._seenUpdateIds].sort((a, b) => a - b);
            const toRemove = ids.slice(0, Math.floor(ids.length / 2));
            for (const id of toRemove) this._seenUpdateIds.delete(id);
          }

          const msg = update.message || update.edited_message;
          if (!msg) continue;
          this._offset = update.update_id + 1;

          const chatId = String(msg.chat?.id || '');
          const from = msg.from?.username || String(msg.from?.id || '');

          // Allowed-user filter
          if (this._allowedUsers.length > 0 && !this._allowedUsers.includes(String(msg.from?.id))) {
            continue;
          }

          // Determine message type and content
          let text = msg.text || msg.caption || '';
          let mediaUrl = null;
          let mediaType = null;

          if (msg.photo) {
            // Photos are sent in multiple sizes; pick the largest
            const largest = msg.photo[msg.photo.length - 1];
            mediaUrl = largest.file_id;
            mediaType = 'photo';
          } else if (msg.document) {
            mediaUrl = msg.document.file_id;
            mediaType = 'document';
          } else if (msg.sticker) {
            mediaType = 'sticker';
            text = msg.sticker.emoji || '[sticker]';
          } else if (msg.audio) {
            mediaType = 'audio';
            text = msg.audio.title || msg.audio.file_name || '[audio]';
          } else if (msg.video) {
            mediaType = 'video';
            text = msg.video.file_name || '[video]';
          }

          if (chatId && (text || mediaType)) {
            this._health.totalReceived++;
            this._health.lastMessageAt = new Date().toISOString();

            this._onMessage('telegram', chatId, text, {
              sender_id: from,
              message_id: msg.message_id,
              chat: msg.chat,
              media_type: mediaType,
              media_url: mediaUrl,
            });
          }
        }

        // Handle callback_query (inline keyboard button press)
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = String(cb.message?.chat?.id || cb.from?.id || '');
          const text = `[callback] ${cb.data || ''}`;
          if (chatId) {
            this._health.totalReceived++;
            this._health.lastMessageAt = new Date().toISOString();
            this._onMessage('telegram', chatId, text, {
              sender_id: cb.from?.username || String(cb.from?.id || ''),
              callback_query_id: cb.id,
              callback_data: cb.data,
              message_id: cb.message?.message_id,
              chat: cb.message?.chat,
            });
          }
        }
      } catch (err) {
        this._health.totalErrors++;
        this._health.lastError = err.message || String(err);
        this._health.connected = false;
      }
    }
  }

  stopPolling() {
    this._running = false;
    this._health.connected = false;
  }

  // ── Health ────────────────────────────────────────────────

  isConnected() { return !!this._token && this._health.connected; }

  getHealth() {
    return {
      ...this._health,
      uptime: this._health.startedAt
        ? Math.floor((Date.now() - new Date(this._health.startedAt).getTime()) / 1000)
        : 0,
    };
  }

  platform() { return 'telegram'; }
}
