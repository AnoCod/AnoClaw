import { describe, expect, it } from 'vitest';
import {
  workspaceFileCapability,
  workspaceFileExtension,
  workspaceSupportsSource,
} from '../WorkspaceFileCapabilities.js';

describe('Workspace read-only file capabilities', () => {
  it('routes dual-mode formats to preview and source without making them editable', () => {
    expect(workspaceFileCapability('README.md')).toMatchObject({ type: 'markdown', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('diagram.svg')).toMatchObject({ type: 'svg', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('report.csv')).toMatchObject({ type: 'csv', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('page.html')).toMatchObject({ type: 'html', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('data.json')).toMatchObject({ type: 'structured', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('events.ndjson')).toMatchObject({ type: 'structured', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('map.geojson')).toMatchObject({ type: 'structured', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('analysis.ipynb')).toMatchObject({ type: 'notebook', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('service.ini')).toMatchObject({ type: 'config', modes: ['preview', 'source'] });
    expect(workspaceFileCapability('.env')).toMatchObject({ type: 'config', modes: ['preview', 'source'] });
  });

  it('recognizes expanded read-only preview families', () => {
    expect(workspaceFileCapability('book.epub').type).toBe('archive');
    expect(workspaceFileCapability('extension.vsix').type).toBe('archive');
    expect(workspaceFileCapability('font.woff2').type).toBe('font');
    expect(workspaceFileCapability('legacy.doc').type).toBe('docx');
    expect(workspaceFileCapability('slides.pptm').type).toBe('pptx');
    expect(workspaceFileCapability('design.psd').type).toBe('psd');
    expect(workspaceFileCapability('large-document.psb').type).toBe('psd');
    expect(workspaceFileCapability('firmware.bin').type).toBe('binary');
    expect(workspaceFileCapability('module.wasm').type).toBe('binary');
    expect(workspaceFileCapability('model.safetensors').type).toBe('binary');
  });

  it('keeps unknown files in a source-only text viewer until binary sampling says otherwise', () => {
    expect(workspaceFileCapability('AGENTS').type).toBe('text');
    expect(workspaceFileCapability('AGENTS').modes).toEqual(['source']);
    expect(workspaceSupportsSource('text')).toBe(true);
    expect(workspaceSupportsSource('binary')).toBe(false);
  });

  it('normalizes extensions across paths and case', () => {
    expect(workspaceFileExtension('docs\\REPORT.JSON')).toBe('json');
  });
});
