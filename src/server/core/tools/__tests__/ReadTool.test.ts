import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadTool } from '../builtin/ReadTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'read-session',
    agentId: 'read-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-read-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('ReadTool', () => {
  it('streams requested line ranges from files larger than the full-read limit', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'large.txt');
    const lines = Array.from({ length: 7000 }, (_unused, index) =>
      `line-${String(index + 1).padStart(4, '0')} ${'x'.repeat(60)}`,
    );
    lines[2999] = 'line-3000 TARGET large file range';
    await writeFile(file, lines.join('\n'));

    const result = await new ReadTool().execute(
      { file_path: file, offset: 3000, limit: 2 },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('TARGET large file range');
    expect(result.content).toContain('line-3001');
    expect(result.content).not.toContain('line-2999');
    expect(result.structured).toMatchObject({
      lineStart: 3000,
      lineEnd: 3001,
      linesRead: 2,
    });
  });

  it('adds line numbers to requested ranges for precise references', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'numbered.txt');
    await writeFile(file, ['alpha', 'beta target', 'gamma'].join('\n'));

    const result = await new ReadTool().execute(
      { file_path: file, offset: 2, limit: 2, line_numbers: true },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('2| beta target');
    expect(result.content).toContain('3| gamma');
    expect(result.structured).toMatchObject({
      lineNumbers: true,
      lineStart: 2,
      lineEnd: 3,
    });
  });

  it('reads the tail of large text files without requiring a known offset', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'app.log');
    const lines = Array.from({ length: 9000 }, (_unused, index) => `log line ${index + 1}`);
    await writeFile(file, lines.join('\n'));

    const result = await new ReadTool().execute(
      { file_path: file, tail: 3, line_numbers: true },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('8998| log line 8998');
    expect(result.content).toContain('9000| log line 9000');
    expect(result.content).not.toContain('8997| log line 8997');
    expect(result.structured).toMatchObject({
      mode: 'tail',
      lineStart: 8998,
      lineEnd: 9000,
      linesRead: 3,
      totalLines: 9000,
      truncatedByLimit: true,
    });
  });

  it('applies max_chars before returning full text content', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'small-but-chatty.txt');
    await writeFile(file, `${'abcde'.repeat(80)}\nkeep-out`);

    const result = await new ReadTool().execute(
      { file_path: file, max_chars: 120 },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.wasTruncated).toBe(true);
    expect(result.content.length).toBeLessThan(200);
    expect(result.content).toContain('Read output truncated at 120 characters');
    expect(result.content).not.toContain('keep-out');
    expect(result.structured).toMatchObject({
      mode: 'full',
      maxChars: 120,
      truncatedByChars: true,
    });
  });

  it('rejects ambiguous or invalid range parameters instead of silently clamping', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'hello\nworld');
    const tool = new ReadTool();

    const badOffset = await tool.execute({ file_path: file, offset: 0 }, ctx(workspace));
    expect(badOffset.success).toBe(false);
    expect(badOffset.errorMessage).toContain('offset must be at least 1');

    const mixedTail = await tool.execute({ file_path: file, tail: 1, limit: 1 }, ctx(workspace));
    expect(mixedTail.success).toBe(false);
    expect(mixedTail.errorMessage).toContain('tail cannot be combined');

    const badLineNumbers = await tool.execute({ file_path: file, line_numbers: 'yes' }, ctx(workspace));
    expect(badLineNumbers.success).toBe(false);
    expect(badLineNumbers.errorMessage).toContain('line_numbers must be a boolean');
  });

  it('rejects full reads of very large text files with actionable guidance', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'large.txt');
    await writeFile(file, `${'0123456789abcdef'.repeat(20000)}\n`);

    const result = await new ReadTool().execute({ file_path: file }, ctx(workspace));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Use offset/limit');
  });

  it('lists directories with stable metadata and directories first', async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, 'src');
    await mkdir(path.join(dir, 'components'), { recursive: true });
    await writeFile(path.join(dir, 'index.ts'), 'export {};');

    const result = await new ReadTool().execute({ file_path: dir }, ctx(workspace));

    expect(result.success).toBe(true);
    expect(result.content).toContain(`Directory: ${dir}`);
    expect(result.content).toContain('components/');
    expect(result.content).toContain('index.ts');
    expect(result.content.indexOf('components/')).toBeLessThan(result.content.indexOf('index.ts'));
  });

  it('returns a binary summary instead of garbled content for binary files', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 255]));

    const result = await new ReadTool().execute({ file_path: file }, ctx(workspace));

    expect(result.success).toBe(true);
    expect(result.content).toContain('[Binary file: blob.bin]');
    expect(result.content).toContain(file);
  });

  it('extracts selected PDF pages via the pages parameter', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.pdf');
    await writeFile(file, createSimplePdf([
      'First page should not be selected.',
      'Second page contains the selected AnoClaw PDF text.',
    ]));

    const result = await new ReadTool().execute(
      { file_path: file, pages: '2' },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Selected pages: 2');
    expect(result.content).toContain('Second page contains the selected AnoClaw PDF text');
    expect(result.content).not.toContain('First page should not be selected');
    expect(result.structured).toMatchObject({
      pageCount: 2,
      selectedPages: [2],
    });
  });
});

function createSimplePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const add = (content: string): number => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];

  for (const text of pageTexts) {
    const stream = `BT /F1 18 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`;
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
