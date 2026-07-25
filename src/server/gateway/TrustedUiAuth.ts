import type { IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TRUSTED_UI_HEADER = 'x-anoclaw-ui-token';

// Ephemeral process-local capability. Electron injects it into requests made by
// AnoClaw windows; it is never persisted or exposed to ordinary HTTP clients.
const trustedUiToken = randomBytes(32).toString('hex');

export function getTrustedUiToken(): string {
  return trustedUiToken;
}

export function isTrustedUiRequest(req: IncomingMessage): boolean {
  const raw = req.headers[TRUSTED_UI_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return false;

  const actual = Buffer.from(candidate);
  const expected = Buffer.from(trustedUiToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
