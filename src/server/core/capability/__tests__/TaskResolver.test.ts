import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../CapabilityRegistry.js';
import { TaskResolver } from '../TaskResolver.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { RiskLevel, Tool } from '../../tools/Tool.js';
import type { ExecutionContext, ToolResult } from '../../tools/Tool.js';

describe('TaskResolver', () => {
  beforeEach(() => {
    CapabilityRegistry.resetInstance();
    ToolRegistry.resetInstance();
  });

  function registerCodingTools(): void {
    for (const toolName of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']) {
      ToolRegistry.getInstance().registerTool(new NamedFixtureTool(toolName));
    }
  }

  it('recommends a provider when a catalog capability is unavailable', async () => {
    const registry = CapabilityRegistry.getInstance();
    registry.setCatalogCapabilities([{
      id: 'widget.create',
      title: 'Create a widget',
      domain: 'utility',
      kind: 'artifact',
      triggers: ['widget'],
      requiredTools: ['widget.render'],
      recommendedPlugins: ['widget-provider'],
    }]);

    const result = await new TaskResolver(registry).resolve({ message: 'Create a widget' });

    expect(result.intent).toBe('capability');
    expect(result.bestCapability?.id).toBe('widget.create');
    expect(result.nextAction).toBe('recommend_plugin');
    expect(result.canStart).toBe(false);
    expect(result.missingTools).toContain('widget.render');
    expect(result.recommendedPlugins).toContain('widget-provider');
  });

  it('uses office mode to prefer office capabilities when matches are otherwise close', async () => {
    const registry = CapabilityRegistry.getInstance();
    registry.setCatalogCapabilities([
      {
        id: 'knowledge.report',
        title: 'Research a report',
        domain: 'knowledge',
        kind: 'knowledge',
        triggers: ['report'],
        priority: 100,
      },
      {
        id: 'office.report',
        title: 'Create an office report',
        domain: 'office',
        kind: 'artifact',
        triggers: ['report'],
        priority: 10,
      },
    ]);

    const result = await new TaskResolver(registry).resolve({
      message: 'make a report',
      userMode: 'office',
    });

    expect(result.userMode).toBe('office');
    expect(result.bestCapability?.id).toBe('office.report');
  });

  it('uses child mode to route learning requests to the education capability', async () => {
    const result = await new TaskResolver().resolve({
      message: '给我孩子讲一下这道数学题',
      userMode: 'child',
    });

    expect(result.userMode).toBe('child');
    expect(result.bestCapability?.id).toBe('education.explain');
    expect(result.nextAction).toBe('recommend_plugin');
    expect(result.recommendedPlugins).toContain('education');
  });

  it('routes programming requests to code implementation capability', async () => {
    const result = await new TaskResolver().resolve({
      message: '帮我修复这个 bug 并跑测试',
      userMode: 'programming',
    });

    expect(result.userMode).toBe('coding');
    expect(result.bestCapability?.id).toBe('code.implement');
  });

  it('suggests reading an explicit code file from the workspace for implementation tasks', async () => {
    registerCodingTools();

    const result = await new TaskResolver().resolve({
      message: '帮我修复 src/server/core/foo.ts 里的 bug 并跑测试',
      userMode: 'programming',
    });

    expect(result.bestCapability?.id).toBe('code.implement');
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'Read',
      parameters: { file_path: 'src/server/core/foo.ts' },
    });
    expect(result.suggestedToolCall?.notes.join(' ')).toContain('IDE/editor context');
  });

  it('suggests a read-only git diff command for code review tasks', async () => {
    registerCodingTools();

    const result = await new TaskResolver().resolve({
      message: 'review code changes before commit',
      userMode: 'programming',
    });

    expect(result.bestCapability?.id).toBe('code.review');
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'Bash',
      parameters: expect.objectContaining({ description: 'Inspect changed files' }),
    });
    expect(String(result.suggestedToolCall?.parameters.command)).toContain('git diff --name-only');
  });

  it('prefers an available runtime capability over a catalog placeholder with the same id', async () => {
    const registry = CapabilityRegistry.getInstance();
    registry.setCatalogCapabilities([{
      id: 'artifact.render',
      title: 'Render an artifact',
      domain: 'utility',
      kind: 'artifact',
      triggers: ['artifact'],
      requiredTools: ['demo.render'],
      recommendedPlugins: ['demo-provider'],
    }]);
    ToolRegistry.getInstance().registerTool(
      new NamedFixtureTool('demo.render'),
      'Demo Provider',
      { source: 'plugin', pluginName: 'demo-provider' },
    );
    registry.registerRuntimeCapabilities('demo-provider', [{
      id: 'artifact.render',
      title: 'Render an artifact',
      domain: 'utility',
      kind: 'artifact',
      triggers: ['artifact'],
      requiredTools: ['demo.render'],
    }], { source: 'plugin', pluginName: 'demo-provider', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({ message: 'Render an artifact' });

    expect(result.bestCapability?.id).toBe('artifact.render');
    expect(result.bestCapability?.source).toBe('plugin');
    expect(result.bestCapability?.sourceName).toBe('demo-provider');
    expect(result.nextAction).toBe('execute_capability');
    expect(result.canStart).toBe(true);
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'demo.render',
      parameters: {},
    });
  });

  it('treats primary freeform inputs as supplied by the user message', async () => {
    ToolRegistry.getInstance().registerTool(
      new NamedFixtureTool('demo.create_text_artifact'),
      'Demo Provider',
      { source: 'plugin', pluginName: 'demo-provider' },
    );
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('demo-provider', [{
      id: 'text-artifact.create',
      title: 'Create a text artifact',
      domain: 'utility',
      kind: 'artifact',
      triggers: ['text artifact'],
      inputs: [{ name: 'content', type: 'string', required: true }],
      requiredTools: ['demo.create_text_artifact'],
    }], { source: 'plugin', pluginName: 'demo-provider', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: 'Create a text artifact containing hello',
    });

    expect(result.bestCapability?.id).toBe('text-artifact.create');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'demo.create_text_artifact',
      parameters: {},
    });
  });
});

class NamedFixtureTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  name(): string { return this.toolName; }
  description(): string { return `${this.toolName} fixture.`; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}
