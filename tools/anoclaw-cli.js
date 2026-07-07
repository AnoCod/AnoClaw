#!/usr/bin/env node
// AnoClaw Mini CLI — Standalone Agent CLI tool (ReAct loop)
// Node.js 18+ only, zero npm dependencies

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Section 2: Config Reader ─────────────────────────────────────────────

function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split('\n');
  const stack = [{ indent: -1, obj: result }];

  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;
    const indent = trimmed.length - trimmed.trimStart().length;
    const match = trimmed.trim().match(/^(\w+):\s*(.*)$/);
    if (!match) continue;
    const [, key, val] = match;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val) {
      parent[key] = val.replace(/^["']|["']$/g, '');
    } else {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    }
  }
  return result;
}

function readConfig() {
  const configPath = path.join(ROOT, 'config', 'settings.yaml');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = parseSimpleYaml(raw);
  const llm = config.llm || {};
  return {
    apiKey: llm.apiKey || process.env.ANOCLAW_API_KEY || '',
    baseUrl: (llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: llm.model || 'deepseek-v4-flash',
  };
}

// Encryption helpers — only used if key has "enc:" prefix (settings.yaml is plaintext)
const ENC_PREFIX = 'enc:';
const IV_LEN = 12;
const TAG_LEN = 16;

function getEncryptionKey() {
  const keyPath = path.join(ROOT, 'config', '.encryption-key');
  const keyB64 = fs.readFileSync(keyPath, 'utf-8').trim();
  return Buffer.from(keyB64, 'base64');
}

function decryptApiKey(value) {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  const key = getEncryptionKey();
  const data = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const encrypted = data.subarray(IV_LEN, data.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf-8');
}

// ── Section 3: Tool Implementations ──────────────────────────────────────

const TOOLS_DEFINITION = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk (max 100KB)',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates parent dirs)',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command (30s timeout)',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
];

function executeTool(name, args) {
  try {
    switch (name) {
      case 'read_file': {
        const filePath = path.resolve(ROOT, args.path);
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > 102400) return content.slice(0, 102400) + '\n[...truncated at 100KB]';
        return content;
      }
      case 'write_file': {
        const filePath = path.resolve(ROOT, args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content, 'utf-8');
        return `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      }
      case 'run_command': {
        const out = execSync(args.command, { encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
        const result = out.length > 5000 ? out.slice(0, 5000) + '\n[...output truncated at 5000 chars]' : out;
        return result || '(command completed with no output)';
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Section 4: API Client ────────────────────────────────────────────────

async function callLLM(baseUrl, apiKey, model, messages) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools: TOOLS_DEFINITION, tool_choice: 'auto', max_tokens: 4096 }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// ── Section 5: ReAct Loop ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant with access to tools. Follow this ReAct loop:

1. **Think** about what the user's task requires
2. **Use tools** to gather information, modify files, or run commands
3. **Repeat** until the task is complete
4. **Respond** with a final summary

Available tools:
- read_file(path): Read file content
- write_file(path, content): Write content to a file
- run_command(command): Execute a shell command

Always explain your actions. When the task is complete, provide a clear summary.`;

async function reactLoop(task, config) {
  const { apiKey, baseUrl, model } = config;
  if (!apiKey) throw new Error('No API key found. Set it in config/settings.yaml or ANOCLAW_API_KEY env var.');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  for (let turn = 0; turn < 10; turn++) {
    const data = await callLLM(baseUrl, apiKey, model, messages);
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error(`API returned no choices: ${JSON.stringify(data).slice(0, 200)}`);

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || '(no response)';
    }

    for (const tc of message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const result = executeTool(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  const last = messages.filter(m => m.role === 'assistant').pop();
  return last?.content || '(max turns reached, no final response)';
}

// ── Section 1: CLI Entry ─────────────────────────────────────────────────

async function main() {
  const task = process.argv.slice(2).join(' ').trim();

  if (!task) {
    console.log('Usage: node tools/anoclaw-cli.js "your task here"');
    process.exit(0);
  }

  try {
    const config = readConfig();
    if (!config.apiKey) {
      console.error('Error: No API key found. Check config/settings.yaml or set ANOCLAW_API_KEY env var.');
      process.exit(1);
    }
    config.apiKey = decryptApiKey(config.apiKey);

    let cancelled = false;
    process.on('SIGINT', () => { cancelled = true; });
    process.on('SIGTERM', () => { cancelled = true; });

    const result = await reactLoop(task, config);
    if (!cancelled) console.log(result);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
