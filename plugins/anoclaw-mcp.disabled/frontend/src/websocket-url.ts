export function resolvePluginWebSocketUrl(
  ...baseCandidates: Array<string | null | undefined>
): string {
  for (const candidate of baseCandidates) {
    if (!candidate) continue;
    try {
      const base = new URL(candidate);
      if (base.protocol !== 'http:' && base.protocol !== 'https:') continue;
      const websocketUrl = new URL('/ws', base);
      websocketUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      return websocketUrl.href;
    } catch {
      // Try the next candidate. srcdoc locations are not valid WebSocket bases.
    }
  }
  throw new Error('Unable to resolve the AnoClaw WebSocket URL');
}
