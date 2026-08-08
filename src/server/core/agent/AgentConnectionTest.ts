import { createLLMProvider } from '../../infra/llm/provider-factory.js';

export interface AgentConnectionTestInput {
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface AgentConnectionTestResult {
  ok: boolean;
  message: string;
  provider: string;
  model: string;
  durationMs: number;
}

export function validateAgentConnectionInput(input: Partial<AgentConnectionTestInput>): string | null {
  if (!input.provider || !input.provider.trim()) return 'Provider is required';
  if (!input.apiUrl || !input.apiUrl.trim()) return 'API URL is required';
  if (!input.model || !input.model.trim()) return 'Model is required';
  if (input.provider !== 'ollama' && !input.apiKey?.trim()) return 'API key is required for cloud providers';
  return null;
}

export interface ModelContextResult {
  ok: boolean;
  contextWindow?: number;
  message?: string;
}

/**
 * Query Ollama's /api/show for a model's native context length.
 * Returns ok:false if the model is unknown or the field is missing.
 */
export async function queryOllamaModelContext(apiUrl: string, model: string, timeoutMs = 10_000): Promise<ModelContextResult> {
  const base = apiUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.trim() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, message: text ? `Ollama error ${response.status}: ${text}` : `Ollama error ${response.status}` };
    }
    const data = await response.json().catch(() => null) as { model_info?: Record<string, unknown> } | null;
    const modelInfo = data?.model_info;
    if (!modelInfo) return { ok: false, message: 'Ollama returned no model_info' };
    const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
    const value = contextKey ? modelInfo[contextKey] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { ok: false, message: 'Model has no context_length in its Ollama profile' };
    }
    return { ok: true, contextWindow: value };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      message: aborted ? `Ollama context query timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function testAgentConnection(input: AgentConnectionTestInput, timeoutMs = 25_000): Promise<AgentConnectionTestResult> {
  const startedAt = Date.now();
  const validationError = validateAgentConnectionInput(input);
  if (validationError) {
    return {
      ok: false,
      message: validationError,
      provider: input.provider || '',
      model: input.model || '',
      durationMs: 0,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const provider = createLLMProvider(input.provider);

  try {
    for await (const event of provider.chat(
      [{ role: 'user', content: 'Reply with OK.' }],
      [],
      'You are testing an AnoClaw model connection. Reply with OK.',
      {
        model: input.model.trim(),
        maxTokens: 8,
        temperature: 0,
        contextWindow: 4096,
        apiUrl: input.apiUrl.trim().replace(/\/+$/, ''),
        apiKey: input.apiKey.trim(),
      },
      controller.signal,
    )) {
      if (event.type === 'error') {
        return {
          ok: false,
          message: event.errorMessage || 'Model connection test failed',
          provider: input.provider,
          model: input.model,
          durationMs: Date.now() - startedAt,
        };
      }
      if (event.type === 'text_delta' || event.type === 'think_delta' || event.type === 'done') {
        if (controller.signal.aborted) {
          return {
            ok: false,
            message: `Model connection test timed out after ${Math.round(timeoutMs / 1000)}s`,
            provider: input.provider,
            model: input.model,
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          ok: true,
          message: 'Model connection verified',
          provider: input.provider,
          model: input.model,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    return {
      ok: false,
      message: 'Model connection test ended without a response',
      provider: input.provider,
      model: input.model,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      message: aborted ? `Model connection test timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message,
      provider: input.provider,
      model: input.model,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    provider.cancel();
  }
}
