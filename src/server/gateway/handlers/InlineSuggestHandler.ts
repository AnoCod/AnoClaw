// InlineSuggestHandler — handles POST /api/v1/inline-suggest
// Lightweight endpoint for Monaco inline code completion.

import * as http from 'http';
import { createLLMProvider } from '../../infra/llm/provider-factory.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';

export async function handleInlineSuggest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  const PREFIX_MAX_LINES = 15;  // Max lines of code before cursor to send as context
  const SUFFIX_MAX_LINES = 3;   // Max lines of code after cursor to send as context

  try {
    const body = await readBody(req);
    const { prefix, suffix, language, sessionId } = body as Record<string, string>;

    if (!prefix && !suffix) {
      sendJson(res, 400, { error: 'Missing content', message: 'prefix or suffix required' });
      return;
    }

    let provider = 'deepseek';
    let model = 'deepseek-chat';
    let apiKey = '';
    let apiUrl = '';

    if (sessionId) {
      const session = SessionManager.getInstance().session(sessionId);
      if (session) {
        const agent = AgentRegistry.getInstance().agent(session.agentId);
        if (agent) {
          provider = agent.provider || provider;
          model = agent.modelName || model;
          apiUrl = agent.apiUrl || '';
          apiKey = agent.apiKey;
        }
      }
    }

    const maxPrefix = (prefix || '').split('\n').slice(-PREFIX_MAX_LINES).join('\n');
    const maxSuffix = (suffix || '').split('\n').slice(0, SUFFIX_MAX_LINES).join('\n');
    const lang = language || 'plaintext';

    const systemPrompt = 'You are a code completion engine. Return ONLY the code to insert at cursor — no explanation, no markdown fences. Keep it short (1-5 lines). Match the surrounding indentation and style. Return empty if nothing meaningful to add.';

    const userPrompt = `Language: ${lang}\n\n=== Before cursor ===\n${maxPrefix}\n=== After cursor ===\n${maxSuffix}\n=== End ===\n\nInsert at cursor:`;

    const emptyExtensionPoints = {} as any;
    const llmProvider = createLLMProvider(provider, emptyExtensionPoints);
    const stream = llmProvider.chat(
      [
        { role: 'user', content: userPrompt },
      ],
      [],
      systemPrompt,
      { model, temperature: 0.1, maxTokens: 120, contextWindow: 8000, apiUrl, apiKey },
      undefined,
    );

    // Consume the async generator, collecting text
    let completion = '';
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.content) {
        completion += event.content;
      }
      if (event.type === 'done' || event.type === 'error') break;
    }

    // Strip markdown fences if present
    completion = completion.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
    sendJson(res, 200, { completion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Suggest failed', message });
  }
}
