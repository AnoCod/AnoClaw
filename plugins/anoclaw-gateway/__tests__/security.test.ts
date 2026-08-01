import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../adapters/TelegramAdapter.js';

describe('Gateway webhook authentication', () => {
  it('accepts only the Telegram secret whose persisted hash matches', () => {
    const secret = 'telegram_webhook_secret_1234';
    const adapter = new TelegramAdapter({
      botToken: 'test-token',
      webhookSecretHash: createHash('sha256').update(secret, 'utf8').digest('hex'),
    });

    expect(adapter.verifyWebhookSecret(secret)).toBe(true);
    expect(adapter.verifyWebhookSecret('telegram_webhook_secret_5678')).toBe(false);
    expect(adapter.verifyWebhookSecret(undefined)).toBe(false);
  });
});
