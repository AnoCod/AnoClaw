/**
 * Minimal OpenCode-style plugin fixture used by the bridge tests.
 */
export function samplePlugin({ tool }) {
  return {
    'session.created': () => 'session hook ran',
    myGreeter: tool({
      name: 'myGreeter',
      description: 'Greets someone',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (params) => `hello ${params.name}`,
    }),
  };
}
