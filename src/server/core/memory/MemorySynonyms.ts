// MemorySynonyms — cross-language synonym/translation map for memory search
// Expands query terms with conceptual equivalents so "日志" matches "logging".
// Uses jieba-wasm for Chinese tokenization when available, falling back to
// whitespace/punctuation splitting.

const SYNONYM_MAP: Record<string, string[]> = {
  // Chinese → English equivalents
  '日志': ['log', 'logging', 'journal'],
  '错误': ['error', 'bug', 'exception', 'failure'],
  '文件': ['file', 'document'],
  '会话': ['session', 'conversation'],
  '搜索': ['search', 'find', 'query'],
  '代理': ['agent', 'bot', 'assistant'],
  '工具': ['tool', 'function', 'utility', 'command'],
  '记忆': ['memory', 'remember', 'store'],
  '计划': ['plan', 'planning', 'design'],
  '测试': ['test', 'testing', 'verify'],
  '构建': ['build', 'compile', 'bundle'],
  '部署': ['deploy', 'release', 'ship'],
  '配置': ['config', 'settings', 'configuration'],
  '权限': ['permission', 'access', 'auth'],
  '网络': ['network', 'ws', 'websocket', 'http'],
  '安全': ['security', 'safe', 'vulnerability'],
  '性能': ['performance', 'speed', 'slow', 'fast'],
  '样式': ['style', 'css', 'theme', 'design'],
  '前端': ['frontend', 'ui', 'browser'],
  '后端': ['backend', 'server', 'api'],
  '数据库': ['database', 'db', 'storage'],
  '消息': ['message', 'msg', 'chat', 'communication'],
  '任务': ['task', 'job', 'work'],
  '工作流': ['workflow', 'pipeline', 'flow'],
  '会议': ['meeting', 'discussion', 'collaboration'],
  '技能': ['skill', 'capability', 'expertise'],

  // English → related terms (for conceptual expansion)
  'logging': ['log', '日志'],
  'session': ['会话', 'conversation', 'context'],
  'error': ['错误', 'bug', 'exception', 'failure', 'crash'],
  'file': ['文件', 'document', 'path'],
  'search': ['搜索', 'find', 'query', 'lookup'],
  'memory': ['记忆', 'remember', 'store', 'persist'],
  'agent': ['代理', 'bot', 'assistant', 'worker'],
  'tool': ['工具', 'function', 'utility', 'command'],
  'plan': ['计划', 'planning', 'design'],
  'test': ['测试', 'testing', 'verify'],
  'build': ['构建', 'compile', 'bundle'],
  'deploy': ['部署', 'release', 'ship'],
  'config': ['配置', 'settings', 'configuration'],
  'permission': ['权限', 'access', 'auth', 'role'],
  'network': ['网络', 'ws', 'websocket', 'http'],
  'security': ['安全', 'safe', 'vulnerability', 'exploit'],
  'performance': ['性能', 'speed', 'slow', 'fast', 'optimize'],
  'style': ['样式', 'css', 'theme', 'design', 'layout', 'ui'],
  'frontend': ['前端', 'ui', 'browser', 'dom'],
  'backend': ['后端', 'server', 'api', 'service'],
  'message': ['消息', 'msg', 'chat', 'communication'],
  'task': ['任务', 'job', 'work', 'assignment'],
  'workflow': ['工作流', 'pipeline', 'flow', 'process'],
  'meeting': ['会议', 'discussion', 'collaboration'],
  'skill': ['技能', 'capability', 'expertise'],
};

// ── Jieba lazy-load (same pattern as MemoryDatabase.tokenize) ──────

let _jiebaCache: { cut: (text: string, hmm?: boolean) => string[] } | null = null;
let _jiebaLoadAttempted = false;

async function ensureJieba(): Promise<{ cut: (text: string, hmm?: boolean) => string[] } | null> {
  if (!_jiebaLoadAttempted) {
    _jiebaLoadAttempted = true;
    try {
      const mod: any = await import('jieba-wasm');
      _jiebaCache = {
        cut: (text: string, hmm?: boolean) => mod.cut(text, hmm ?? true),
      };
    } catch {
      // jieba-wasm unavailable — will use fallback tokenizer
    }
  }
  return _jiebaCache;
}

// ── Query expansion ─────────────────────────────────────────────────

/**
 * Expand a query string with synonym/translation terms.
 *
 * Tokenizes the query using jieba-wasm (Chinese-aware) when available,
 * falling back to whitespace/punctuation split. Each token is looked up
 * in the synonym map; matching synonyms are appended to the query.
 *
 * Only adds terms when there is an exact key match — no fuzzy expansion
 * of synonyms. Each matching key contributes its value array exactly once.
 *
 * Cross-language safety: CJK expansion terms are only added when the
 * original query already contains CJK characters. This prevents Fuse.js
 * from failing on mixed-script queries where CJK chars can't match
 * against ASCII-only content.
 */
export async function expand(query: string): Promise<string> {
  if (!query || query.trim().length === 0) return query;

  const jieba = await ensureJieba();

  let tokens: string[];
  if (jieba?.cut) {
    tokens = jieba.cut(query) as string[];
  } else {
    // Fallback: simple whitespace/punctuation split
    tokens = query.split(/[\s\p{P}]+/u).filter(t => t.length >= 1);
  }

  const expansions = new Set<string>();

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const synonyms = SYNONYM_MAP[lower];
    if (synonyms) {
      for (const syn of synonyms) {
        if (!expansions.has(syn)) expansions.add(syn);
      }
    }
  }

  if (expansions.size === 0) return query;

  // Filter: only include CJK expansions if the original query contains CJK
  const queryHasCJK = hasCJK(query);
  const safe = queryHasCJK
    ? [...expansions]
    : [...expansions].filter(s => !hasCJK(s));

  if (safe.length === 0) return query;
  return query + ' ' + safe.join(' ');
}

function hasCJK(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF)
    ) {
      return true;
    }
  }
  return false;
}
