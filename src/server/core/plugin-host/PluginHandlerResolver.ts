export interface PluginHandlerRequest {
  body: unknown;
  params: Record<string, string>;
  query: string;
  headers: Record<string, string>;
  method: string;
  path: string;
}

export type PluginHttpHandler = (request: PluginHandlerRequest) => unknown | Promise<unknown>;

/** Resolve class-style instance handlers first while preserving function-style module exports. */
export function resolvePluginHttpHandler(
  moduleExports: Record<string, unknown>,
  activeInstance: object | null,
  handlerName: string,
): PluginHttpHandler | null {
  if (activeInstance) {
    const instanceHandler = Reflect.get(activeInstance, handlerName) as unknown;
    if (typeof instanceHandler === 'function') {
      return instanceHandler.bind(activeInstance) as PluginHttpHandler;
    }
  }

  const exportedHandler = moduleExports[handlerName];
  return typeof exportedHandler === 'function'
    ? exportedHandler as PluginHttpHandler
    : null;
}
