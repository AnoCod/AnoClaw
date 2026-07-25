import { V3DomainError } from './DomainError.js';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'secret',
  'clientsecret',
  'privatekey',
  'authorization',
  'cookie',
  'credentials',
]);

export function assertNoSensitiveFields(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      throw new V3DomainError(
        'SENSITIVE_FIELD',
        `Sensitive field is not permitted in v3 persistence: ${path}.${key}`,
        { path: `${path}.${key}` },
      );
    }
    assertNoSensitiveFields(nested, `${path}.${key}`);
  }
}
function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}
