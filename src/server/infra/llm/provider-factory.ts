// LLM Provider factory — no vendor lock-in, no hardcoded providers
// Just URL + API Key + Model Name to use any compatible API
// Ollama only needs URL (default http://localhost:11434) + Model Name

import type { LLMProvider } from './LLMProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { OllamaProvider } from './OllamaProvider.js';

export function createLLMProvider(provider: string, extPoints?: { get(point: string): ((...args: unknown[]) => unknown) | null }): LLMProvider {
  // Check for plugin override
  if (extPoints) {
    const override = extPoints.get('llmProvider');
    if (override) {
      const customProvider = override({ provider }) as LLMProvider;
      if (customProvider && typeof (customProvider as unknown as { chat: unknown }).chat === 'function') {
        return customProvider;
      }
    }
  }

  switch (provider) {
    case 'ollama':
      return new OllamaProvider();
    default:
      return new OpenAICompatibleProvider();
  }
}
