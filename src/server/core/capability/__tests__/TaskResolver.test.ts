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

  it('maps an everyday PPT request to the presentation capability and recommends the official office plugin', async () => {
    const result = await new TaskResolver().resolve({
      message: 'Create a company year-end summary PPT',
    });

    expect(result.intent).toBe('capability');
    expect(result.bestCapability?.id).toBe('presentation.create');
    expect(result.nextAction).toBe('recommend_plugin');
    expect(result.canStart).toBe(false);
    expect(result.missingTools).toContain('office.create_pptx');
    expect(result.recommendedPlugins).toContain('anoclaw-office');
  });

  it('matches Chinese presentation wording', async () => {
    const result = await new TaskResolver().resolve({
      message: '帮我做一个公司年终总结PPT',
    });

    expect(result.intent).toBe('capability');
    expect(result.userMode).toBe('simple');
    expect(result.bestCapability?.id).toBe('presentation.create');
  });

  it('uses office mode to prefer office capabilities when matches are otherwise close', async () => {
    const registry = CapabilityRegistry.getInstance();
    registry.setCatalogCapabilities([
      {
        id: 'web.report',
        title: 'Research a report',
        domain: 'web',
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

  it('prefers an available plugin capability over a catalog placeholder with the same id', async () => {
    ToolRegistry.getInstance().registerTool(new CreatePptFixtureTool(), 'Office', { source: 'plugin', pluginName: 'office' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('office', [
      {
        id: 'presentation.create',
        title: 'Create a presentation',
        domain: 'office',
        kind: 'artifact',
        triggers: ['ppt'],
        requiredTools: ['office.create_pptx'],
        outputs: [{ type: 'file', extension: 'pptx', artifactType: 'presentation' }],
      },
    ], { source: 'plugin', pluginName: 'office', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: 'Create a new product launch PPT',
    });

    expect(result.bestCapability?.id).toBe('presentation.create');
    expect(result.bestCapability?.source).toBe('plugin');
    expect(result.bestCapability?.sourceName).toBe('office');
    expect(result.nextAction).toBe('execute_capability');
    expect(result.canStart).toBe(true);
  });

  it('treats primary freeform inputs as supplied by the user message', async () => {
    ToolRegistry.getInstance().registerTool(new GenerateQrFixtureTool(), 'Utility', { source: 'plugin', pluginName: 'qrcode' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('qrcode', [
      {
        id: 'qrcode.create',
        title: 'Create a QR code',
        domain: 'utility',
        kind: 'artifact',
        triggers: ['qr code'],
        inputs: [{ name: 'content', type: 'string', required: true }],
        requiredTools: ['generateQRCode'],
        outputs: [{ type: 'file', extension: 'png', artifactType: 'image' }],
      },
    ], { source: 'plugin', pluginName: 'qrcode', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: 'Create a QR code for https://example.com',
    });

    expect(result.bestCapability?.id).toBe('qrcode.create');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
  });
});

class CreatePptFixtureTool extends Tool {
  name(): string { return 'office.create_pptx'; }
  description(): string { return 'Create a PPTX file.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

class GenerateQrFixtureTool extends Tool {
  name(): string { return 'generateQRCode'; }
  description(): string { return 'Generate a QR code.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}
