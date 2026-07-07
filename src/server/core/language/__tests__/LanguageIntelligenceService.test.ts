import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageIntelligenceService } from '../LanguageIntelligenceService.js';

describe('LanguageIntelligenceService', () => {
  const roots: string[] = [];

  afterEach(() => {
    LanguageIntelligenceService.resetInstance();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('provides TypeScript completions, hover, definitions, and diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anoclaw-ls-'));
    roots.push(root);
    const filePath = path.join(root, 'main.ts');
    const content = [
      'export function helper(name: string): string {',
      '  return name.toUpperCase();',
      '}',
      '',
      'const item = { alpha: 1, beta: 2 };',
      'item.',
      "helper('ano');",
      "const bad: number = 'oops';",
      '',
    ].join('\n');
    const completeContent = content;
    const checkedContent = content.replace('item.', 'item.alpha;');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
      include: ['**/*.ts'],
    }), 'utf8');
    fs.writeFileSync(filePath, checkedContent, 'utf8');

    const service = LanguageIntelligenceService.getInstance();
    const base = { workspaceRoot: root, filePath, content: checkedContent, language: 'typescript' };

    const completions = await service.complete({ ...base, content: completeContent, line: 6, column: 6 });
    expect(completions.some(item => item.label === 'alpha')).toBe(true);

    const hover = await service.hover({ ...base, line: 7, column: 2 });
    expect(hover?.contents).toContain('helper');
    expect(hover?.contents).toContain('string');

    const definitions = await service.definition({ ...base, line: 7, column: 2 });
    expect(definitions[0]).toMatchObject({
      path: 'main.ts',
      external: false,
      range: { startLineNumber: 1 },
    });

    const diagnostics = await service.diagnostics({ ...base, line: 8, column: 12 });
    expect(diagnostics.some(item => item.severity === 'error' && item.message.includes('number'))).toBe(true);
  });

  it('uses Pyright for Python definitions and diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anoclaw-pyright-'));
    roots.push(root);
    const filePath = path.join(root, 'main.py');
    const content = [
      'def greet(name: str) -> str:',
      '    return name.upper()',
      '',
      'greet(123)',
      '',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');

    const service = LanguageIntelligenceService.getInstance();
    const base = { workspaceRoot: root, filePath, content, language: 'python' };

    const definitions = await service.definition({ ...base, line: 4, column: 2 });
    expect(definitions[0]).toMatchObject({
      path: 'main.py',
      external: false,
      range: { startLineNumber: 1 },
    });

    const diagnostics = await service.diagnostics({ ...base, content: `${content}\ndef broken(:\n`, line: 6, column: 12 });
    expect(diagnostics.some(item => item.source === 'pyright' && item.severity === 'error')).toBe(true);
  }, 15000);
});
