// UIComponentRegistry.ts — Global component swap registry.
// Plugins call register('Button', MyButton) to override built-in components.

const _defaults = new Map<string, unknown>();
const _overrides = new Map<string, unknown>();

export const uiRegistry = {
  registerDefault(name: string, Component: unknown): void {
    _defaults.set(name, Component);
  },

  register<T>(name: string, Component: T): void {
    console.log(`[UI] component override: "${name}"`, Component);
    _overrides.set(name, Component);
  },

  unregister(name: string): void {
    console.log(`[UI] component unregistered: "${name}" — back to default`);
    _overrides.delete(name);
  },

  get<T>(name: string): T {
    const override = _overrides.get(name);
    if (override) return override as T;
    const def = _defaults.get(name);
    if (def) return def as T;
    throw new Error(`UIComponentRegistry: "${name}" not registered`);
  },

  has(name: string): boolean {
    return _overrides.has(name) || _defaults.has(name);
  },

  getAll(): string[] {
    return [...new Set([..._defaults.keys(), ..._overrides.keys()])];
  },
};
