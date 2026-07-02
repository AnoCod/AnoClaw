// ToolCardRegistry.ts — Maps tool names to custom card components.
// Plugins register: anoclaw.ui.registerToolCard('my_tool', MyCardComponent)
// Built-in presets: 'default' → ToolCard, 'result' → ToolCardResult, etc.

const _presets = new Map<string, unknown>();
const _overrides = new Map<string, unknown>();

export const toolCardRegistry = {
  registerPreset(name: string, Component: unknown): void {
    _presets.set(name, Component);
  },

  /** Plugin override: register a custom card for a specific tool name. */
  register(toolName: string, Component: unknown): void {
    _overrides.set(toolName, Component);
  },

  /** Unregister override — falls back to preset. */
  unregister(toolName: string): void {
    _overrides.delete(toolName);
  },

  /** Get the card component for a tool. null means fall back to default. */
  get(toolName: string, cardStyle?: string): unknown | null {
    if (_overrides.has(toolName)) return _overrides.get(toolName) || null;
    if (cardStyle && _presets.has(cardStyle)) return _presets.get(cardStyle) || null;
    return _presets.get('default') || null;
  },

  has(toolName: string): boolean {
    return _overrides.has(toolName);
  },
};
