// Plugin Lab - diagnostics plugin using PluginBase.

// @ts-ignore: PluginBase is set as global by PluginHost before loading plugins.
const { PluginBase } = globalThis;

export default class TestPlugin extends PluginBase {
  async onload() {
    this.api.log.info('Plugin Lab activating');

    const data = await this.loadData();
    data.bootCount = Number(data.bootCount || 0) + 1;
    data.lastBootAt = new Date().toISOString();
    await this.saveData(data);

    await this.registerTool({
      name: 'TestPluginPing',
      description: 'Returns a structured pong response and verifies plugin tool execution works.',
      parametersSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'A message to echo back' },
        },
        required: [],
      },
      category: 'Plugin',
    });

    await this.registerRoute('GET', '/api/v1/plugins/test-plugin/diagnostics', 'getDiagnostics');
  }

  async onToolExecute(toolName, params) {
    if (toolName === 'TestPluginPing') {
      return JSON.stringify({
        ok: true,
        message: params.message || 'no message',
        plugin: 'Plugin Lab',
        at: new Date().toISOString(),
      }, null, 2);
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  async getDiagnostics() {
    const data = await this.loadData();
    const [plugins, pluginStatus, agents, tools] = await Promise.all([
      this._safeCall('GET', '/api/v1/plugins'),
      this._safeCall('GET', '/api/v1/plugins/status'),
      this._safeCall('GET', '/api/v1/agents'),
      this._safeCall('GET', '/api/v1/tools'),
    ]);

    return {
      status: 200,
      body: {
        ok: true,
        at: new Date().toISOString(),
        bootCount: data.bootCount || 0,
        lastBootAt: data.lastBootAt || null,
        plugins: this._summarizePlugins(plugins.body || plugins),
        pluginStatus: pluginStatus.body || pluginStatus,
        agents: this._summarizeAgents(agents.body || agents),
        tools: this._summarizeTools(tools.body || tools),
      },
    };
  }

  async _safeCall(method, path) {
    try {
      const result = await this.api.api.call(method, path);
      return result?.body !== undefined ? result : { statusCode: 200, body: result };
    } catch (err) {
      return { statusCode: 500, body: { error: err.message } };
    }
  }

  _summarizePlugins(payload) {
    const plugins = payload.plugins || payload.items || [];
    return {
      total: plugins.length,
      active: plugins.filter(p => p.status === 'active' || p.active || p.activated).length,
      error: plugins.filter(p => p.status === 'error' || p.error).length,
      items: plugins.map(p => ({
        name: p.name,
        displayName: p.displayName || p.name,
        version: p.version || '',
        status: p.status || (p.active ? 'active' : 'unknown'),
      })),
    };
  }

  _summarizeAgents(payload) {
    const agents = payload.agents || payload.items || [];
    return {
      total: agents.length,
      active: agents.filter(a => a.isActive !== false).length,
      items: agents.slice(0, 8).map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        level: a.level,
      })),
    };
  }

  _summarizeTools(payload) {
    const tools = payload.tools || payload.items || [];
    const groups = payload.groups || [];
    return {
      total: payload.total || tools.length,
      groups: Array.isArray(groups) ? groups : Object.keys(groups),
      sample: tools.slice(0, 10).map(t => ({ name: t.name || t.id, group: t.group || t.category || '' })),
    };
  }

  async onunload() {
    this.api.log.info('Plugin Lab deactivated');
  }
}
