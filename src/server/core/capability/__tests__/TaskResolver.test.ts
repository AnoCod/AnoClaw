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
    expect(result.pluginRecommendations[0]).toMatchObject({
      pluginName: 'anoclaw-office',
    });
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

  it('routes programming requests to code implementation capability', async () => {
    const result = await new TaskResolver().resolve({
      message: '帮我修复这个 bug 并跑测试',
      userMode: 'programming',
    });

    expect(result.userMode).toBe('coding');
    expect(result.bestCapability?.id).toBe('code.implement');
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
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'office.create_pptx',
      parameters: expect.objectContaining({
        topic: expect.stringContaining('product launch PPT'),
        slideCount: 8,
      }),
    });
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
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'generateQRCode',
      parameters: {},
    });
  });

  it('treats document titles as supplied by the user message', async () => {
    ToolRegistry.getInstance().registerTool(new CreateDocFixtureTool(), 'Office', { source: 'plugin', pluginName: 'office' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('office', [
      {
        id: 'document.create',
        title: 'Create a document',
        domain: 'office',
        kind: 'artifact',
        triggers: ['report', '报告'],
        inputs: [{ name: 'title', type: 'string', required: true }],
        requiredTools: ['office.create_docx'],
        outputs: [{ type: 'file', extension: 'docx', artifactType: 'document' }],
      },
    ], { source: 'plugin', pluginName: 'office', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: '帮我写一份公司年终总结报告',
      userMode: 'office',
    });

    expect(result.bestCapability?.id).toBe('document.create');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
  });

  it('routes spreadsheet analysis requests to the office spreadsheet capability', async () => {
    ToolRegistry.getInstance().registerTool(new AnalyzeSpreadsheetFixtureTool(), 'Office', { source: 'plugin', pluginName: 'office' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('office', [
      {
        id: 'spreadsheet.analyze',
        title: 'Analyze a spreadsheet',
        domain: 'data',
        kind: 'analysis',
        triggers: ['excel', 'csv', '表格', '图表'],
        inputs: [{ name: 'filePath', type: 'file', required: false }],
        requiredTools: ['office.analyze_spreadsheet'],
        outputs: [{ type: 'file', extension: 'xlsx', artifactType: 'spreadsheet' }],
      },
    ], { source: 'plugin', pluginName: 'office', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: '把这个 CSV 做成图表并写分析',
      userMode: 'office',
    });

    expect(result.bestCapability?.id).toBe('spreadsheet.analyze');
    expect(result.bestCapability?.source).toBe('plugin');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'office.analyze_spreadsheet',
      parameters: expect.objectContaining({
        title: expect.stringContaining('CSV'),
      }),
      notes: expect.arrayContaining([
        expect.stringContaining('No spreadsheet path'),
      ]),
    });
  });

  it('routes PDF summary requests to the official PDF capability', async () => {
    ToolRegistry.getInstance().registerTool(new SummarizePdfFixtureTool(), 'PDF', { source: 'plugin', pluginName: 'anoclaw-pdf' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('anoclaw-pdf', [
      {
        id: 'pdf.summarize',
        title: 'Summarize a PDF',
        domain: 'pdf',
        kind: 'analysis',
        triggers: ['pdf', 'PDF总结', '总结PDF'],
        inputs: [{ name: 'filePath', type: 'file', required: false }],
        requiredTools: ['pdf.summarize'],
        outputs: [{ type: 'file', extension: 'md', artifactType: 'document' }],
      },
    ], { source: 'plugin', pluginName: 'anoclaw-pdf', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: '把 C:\\Docs\\report.pdf 总结成一页报告',
      userMode: 'office',
    });

    expect(result.bestCapability?.id).toBe('pdf.summarize');
    expect(result.bestCapability?.source).toBe('plugin');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'pdf.summarize',
      parameters: expect.objectContaining({
        filePath: 'C:\\Docs\\report.pdf',
      }),
    });
  });

  it('routes folder organization requests to the official files capability', async () => {
    ToolRegistry.getInstance().registerTool(new OrganizeFilesFixtureTool(), 'Files', { source: 'plugin', pluginName: 'anoclaw-files' });
    const registry = CapabilityRegistry.getInstance();
    registry.registerRuntimeCapabilities('anoclaw-files', [
      {
        id: 'files.organize',
        title: 'Organize local files',
        domain: 'files',
        kind: 'automation',
        triggers: ['organize files', 'folder', '整理文件', '文件夹'],
        inputs: [{ name: 'folderPath', type: 'folder', required: false }],
        requiredTools: ['files.organize'],
        outputs: [{ type: 'artifact', artifactType: 'automation_result' }],
      },
    ], { source: 'plugin', pluginName: 'anoclaw-files', pluginStatus: 'activated' });

    const result = await new TaskResolver(registry).resolve({
      message: '帮我整理这个文件夹',
      userMode: 'office',
    });

    expect(result.bestCapability?.id).toBe('files.organize');
    expect(result.bestCapability?.source).toBe('plugin');
    expect(result.missingInputs).toEqual([]);
    expect(result.nextAction).toBe('execute_capability');
    expect(result.suggestedToolCall).toMatchObject({
      toolName: 'files.organize',
      parameters: expect.objectContaining({
        apply: false,
        recursive: false,
      }),
      notes: expect.arrayContaining([
        expect.stringContaining('No folder path'),
      ]),
    });
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

class CreateDocFixtureTool extends Tool {
  name(): string { return 'office.create_docx'; }
  description(): string { return 'Create a DOCX file.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

class AnalyzeSpreadsheetFixtureTool extends Tool {
  name(): string { return 'office.analyze_spreadsheet'; }
  description(): string { return 'Analyze spreadsheet data.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

class SummarizePdfFixtureTool extends Tool {
  name(): string { return 'pdf.summarize'; }
  description(): string { return 'Summarize a PDF file.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

class OrganizeFilesFixtureTool extends Tool {
  name(): string { return 'files.organize'; }
  description(): string { return 'Organize files in a folder.'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [] };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}
