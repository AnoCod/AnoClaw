/**
 * Shared OpenCode plugin runtime — used both by the worker bridge and by
 * in-process (test) mode. Loads a plugin module, calls its exported plugin
 * functions with an OpenCode-style context, and exposes tools + hooks.
 */

export interface OpenCodeToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenCodeRuntime {
  invoke(name: string, params: unknown, extra?: unknown[]): Promise<unknown>;
  toolDefs: OpenCodeToolDef[];
  hookNames: string[];
  logs: Array<{ level: string; args: unknown[] }>;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Run an imported OpenCode plugin module. `mod` is the module namespace object
 * obtained from dynamic import.
 */
export function runOpenCodePluginModule(
  mod: Record<string, unknown>,
  cwd: string,
): OpenCodeRuntime {
  const logs: Array<{ level: string; args: unknown[] }> = [];
  const hooks: Record<string, AnyFn> = {};
  const tools: Record<string, AnyFn> = {};
  const toolDefs: OpenCodeToolDef[] = [];

  const context = {
    project: { root: cwd },
    directory: cwd,
    worktree: null,
    client: {
      app: {
        log: (...args: unknown[]) => logs.push({ level: 'info', args }),
      },
    },
    $: async (): Promise<never> => {
      throw new Error('Shell API ($) is not available in the AnoClaw OpenCode bridge');
    },
    tool: (def: Record<string, unknown>) => {
      const name = String(def.name ?? `opencode_tool_${toolDefs.length + 1}`);
      const execute = typeof def.execute === 'function' ? (def.execute as AnyFn) : undefined;
      toolDefs.push({
        name,
        description: typeof def.description === 'string' ? def.description : undefined,
        parameters: (def.parameters ?? def.argsSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      });
      if (execute) tools[name] = execute;
      return def;
    },
  };

  const exported = Object.values(mod).filter((v): v is AnyFn => typeof v === 'function');
  for (const fn of exported) {
    const result = fn(context);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // Plugins are expected to return synchronously; promise-returning plugins
      // cannot be awaited here because the runtime is sync by contract.
      logs.push({ level: 'warn', args: ['Plugin function returned a Promise; async plugins are not supported'] });
      continue;
    }
    if (result && typeof result === 'object') {
      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        if (typeof value === 'function') {
          hooks[key] = value as AnyFn;
        } else if (value && typeof value === 'object' && typeof (value as { execute?: unknown }).execute === 'function') {
          const def = value as Record<string, unknown>;
          const name = String(def.name ?? key);
          toolDefs.push({
            name,
            description: typeof def.description === 'string' ? def.description : undefined,
            parameters: (def.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          });
          tools[name] = def.execute as AnyFn;
        }
      }
    }
  }

  return {
    invoke: async (name: string, params: unknown, extra?: unknown[]) => {
      const fn = hooks[name] ?? tools[name];
      if (!fn) throw new Error(`Unknown OpenCode hook/tool: ${name}`);
      return fn(params, ...(extra ?? []));
    },
    toolDefs,
    hookNames: Object.keys(hooks),
    logs,
  };
}
