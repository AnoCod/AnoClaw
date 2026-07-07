import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdfSummaryArtifact, extractPdfText } from '../extension.js';

describe('anoclaw-pdf summary tool', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-pdf-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('extracts text from a simple PDF', async () => {
    const pdfPath = path.join(root, 'sample.pdf');
    await fs.writeFile(pdfPath, createSimplePdf([
      'AnoClaw turns PDF documents into concise office reports.',
    ]));

    const extraction = await extractPdfText(pdfPath, { maxPages: 5, maxChars: 5000 });

    expect(extraction.pageCount).toBe(1);
    expect(extraction.selectedPages).toEqual([1]);
    expect(extraction.text).toContain('AnoClaw turns PDF documents');
  });

  it('creates a markdown PDF summary artifact', async () => {
    const pdfPath = path.join(root, 'market-report.pdf');
    await fs.writeFile(pdfPath, createSimplePdf([
      'AnoClaw market report. Revenue increased in the office segment. Customer support requests decreased after the new workflow shipped. The next priority is PDF automation for daily work.',
    ]));
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'pdf-art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const fakeApi = {
      context: { storagePath: root },
      api: { call: apiCall },
    };

    const result = await createPdfSummaryArtifact({
      filePath: pdfPath,
      title: 'Market report summary',
      summaryBullets: 3,
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('pdf-art-test');
    expect(result.pageCount).toBe(1);
    expect(result.selectedPages).toEqual([1]);
    expect(result.preview).toContain('Market report summary');
    expect(result.preview).toContain('Revenue increased');
    const markdown = await fs.readFile(result.filePath, 'utf8');
    expect(markdown).toContain('## Summary');
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'pdf',
      status: 'done',
      capabilityId: 'pdf.summarize',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
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

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

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
