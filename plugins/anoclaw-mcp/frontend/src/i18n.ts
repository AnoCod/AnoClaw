export type McpLocale = 'zh-CN' | 'en-US';
type Params = Record<string, string | number | boolean | null | undefined>;

const enUS = {
  'mcp.title': 'MCP Servers',
  'mcp.subtitle': 'Model Context Protocol — connect external tools and services',
  'mcp.logs': 'Logs',
  'mcp.connectServer': '+ Connect Server',
  'mcp.status.connected': 'Connected',
  'mcp.status.disconnected': 'Disconnected',
  'mcp.status.offline': 'Disconnected — server is offline',
  'mcp.count.tools': '{count} tools',
  'mcp.count.resources': '{count} resources',
  'mcp.count.prompts': '{count} prompts',
  'mcp.count.connected': '{connected}/{total} connected',
  'mcp.count.toolsAvailable': '{count} tools available',
  'mcp.action.edit': 'Edit',
  'mcp.action.reconnect': 'Reconnect',
  'mcp.action.delete': 'Delete',
  'mcp.schema.input': 'Input Schema',
  'mcp.schema.any': 'any',
  'mcp.schema.required': 'required',
  'mcp.logs.title': 'Connection Logs',
  'mcp.logs.empty': 'No connection logs yet.',
  'mcp.load.failed': 'Failed to load: {message}',
  'mcp.empty.title': 'No MCP servers connected',
  'mcp.empty.description': 'Connect to filesystem servers, API gateways, databases, and more to extend your AI agents with external tools.',
  'mcp.detail.loadFailed': 'Failed to load server: {message}',
  'mcp.detail.toolsTab': 'Tools ({count})',
  'mcp.detail.resourcesTab': 'Resources ({count})',
  'mcp.detail.promptsTab': 'Prompts ({count})',
  'mcp.detail.noTools': 'No tools exposed by this server.',
  'mcp.detail.searchTools': 'Search tools...',
  'mcp.detail.noMatchingTools': 'No tools matching "{query}"',
  'mcp.detail.noResources': 'No resources exposed by this server.',
  'mcp.detail.noPrompts': 'No prompts exposed by this server.',
  'mcp.form.editTitle': 'Edit Server',
  'mcp.form.connectTitle': 'Connect MCP Server',
  'mcp.form.name': 'Name',
  'mcp.form.transport': 'Transport',
  'mcp.form.command': 'Command (stdio)',
  'mcp.form.commandHelp': 'Shell command to launch the MCP server process',
  'mcp.form.url': 'URL (sse/http)',
  'mcp.form.urlHelp': 'HTTP endpoint for SSE or HTTP transport',
  'mcp.form.environment': 'Environment Variables',
  'mcp.form.environmentHelp': 'One KEY=value per line. Merged over system env for stdio servers.',
  'mcp.form.update': 'Update & Reconnect',
  'mcp.form.save': 'Save & Connect',
  'mcp.form.cancel': 'Cancel',
  'mcp.form.nameRequired': 'Name is required',
  'mcp.form.saved': 'Server "{name}" {action}',
  'mcp.form.savedAction': 'saved',
  'mcp.form.updatedAction': 'updated',
  'mcp.form.saveFailed': 'Save failed: {message}',
  'mcp.delete.title': 'Delete Server',
  'mcp.delete.description': 'This MCP server and all its tools will no longer be available to agents. This action cannot be undone.',
  'mcp.delete.cancel': 'Cancel',
  'mcp.delete.confirm': 'Delete',
  'mcp.delete.done': 'Server deleted',
  'mcp.delete.failed': 'Delete failed: {message}',
  'mcp.reconnect.done': 'Reconnected',
  'mcp.reconnect.failed': 'Reconnect failed: {message}',
} as const;

export type McpTranslationKey = keyof typeof enUS;

const zhCN: Record<McpTranslationKey, string> = {
  'mcp.title': 'MCP 服务器',
  'mcp.subtitle': '模型上下文协议 — 连接外部工具与服务',
  'mcp.logs': '日志',
  'mcp.connectServer': '+ 连接服务器',
  'mcp.status.connected': '已连接',
  'mcp.status.disconnected': '未连接',
  'mcp.status.offline': '未连接 — 服务器离线',
  'mcp.count.tools': '{count} 个工具',
  'mcp.count.resources': '{count} 个资源',
  'mcp.count.prompts': '{count} 个提示词',
  'mcp.count.connected': '已连接 {connected}/{total}',
  'mcp.count.toolsAvailable': '{count} 个工具可用',
  'mcp.action.edit': '编辑',
  'mcp.action.reconnect': '重新连接',
  'mcp.action.delete': '删除',
  'mcp.schema.input': '输入结构',
  'mcp.schema.any': '任意',
  'mcp.schema.required': '必填',
  'mcp.logs.title': '连接日志',
  'mcp.logs.empty': '暂无连接日志。',
  'mcp.load.failed': '加载失败：{message}',
  'mcp.empty.title': '尚未连接 MCP 服务器',
  'mcp.empty.description': '连接文件系统服务器、API 网关、数据库等外部服务，为 AI 智能体扩展工具能力。',
  'mcp.detail.loadFailed': '加载服务器失败：{message}',
  'mcp.detail.toolsTab': '工具（{count}）',
  'mcp.detail.resourcesTab': '资源（{count}）',
  'mcp.detail.promptsTab': '提示词（{count}）',
  'mcp.detail.noTools': '此服务器没有公开工具。',
  'mcp.detail.searchTools': '搜索工具…',
  'mcp.detail.noMatchingTools': '没有匹配“{query}”的工具',
  'mcp.detail.noResources': '此服务器没有公开资源。',
  'mcp.detail.noPrompts': '此服务器没有公开提示词。',
  'mcp.form.editTitle': '编辑服务器',
  'mcp.form.connectTitle': '连接 MCP 服务器',
  'mcp.form.name': '名称',
  'mcp.form.transport': '传输方式',
  'mcp.form.command': '命令（stdio）',
  'mcp.form.commandHelp': '用于启动 MCP 服务器进程的 Shell 命令',
  'mcp.form.url': 'URL（sse/http）',
  'mcp.form.urlHelp': 'SSE 或 HTTP 传输使用的 HTTP 端点',
  'mcp.form.environment': '环境变量',
  'mcp.form.environmentHelp': '每行一个 KEY=value；stdio 服务器会将其合并到系统环境变量中。',
  'mcp.form.update': '更新并重新连接',
  'mcp.form.save': '保存并连接',
  'mcp.form.cancel': '取消',
  'mcp.form.nameRequired': '名称为必填项',
  'mcp.form.saved': '服务器“{name}”已{action}',
  'mcp.form.savedAction': '保存',
  'mcp.form.updatedAction': '更新',
  'mcp.form.saveFailed': '保存失败：{message}',
  'mcp.delete.title': '删除服务器',
  'mcp.delete.description': '删除后，智能体将无法再使用此 MCP 服务器及其所有工具。此操作无法撤销。',
  'mcp.delete.cancel': '取消',
  'mcp.delete.confirm': '删除',
  'mcp.delete.done': '服务器已删除',
  'mcp.delete.failed': '删除失败：{message}',
  'mcp.reconnect.done': '已重新连接',
  'mcp.reconnect.failed': '重新连接失败：{message}',
};

const dictionaries: Record<McpLocale, Record<McpTranslationKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

declare global {
  interface Window {
    __ANOCLAW_LOCALE__?: unknown;
  }
}

let locale: McpLocale = normalizeMcpLocale(
  typeof window === 'undefined' ? undefined : window.__ANOCLAW_LOCALE__,
);

export function normalizeMcpLocale(value: unknown): McpLocale {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'en' || raw === 'en-us' ? 'en-US' : 'zh-CN';
}

export function setMcpLocale(value: unknown): McpLocale {
  locale = normalizeMcpLocale(value);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  return locale;
}

export function getMcpLocale(): McpLocale {
  return locale;
}

export function t(key: McpTranslationKey, params: Params = {}): string {
  return dictionaries[locale][key].replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export const mcpDictionaries = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const;
