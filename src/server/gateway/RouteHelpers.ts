// RouteHelpers — standalone utility functions for route handlers
// Avoids coupling route handlers to ApiServer's private methods.

import type { IncomingMessage, ServerResponse } from 'node:http';

export type SendJson = (res: ServerResponse, status: number, data: unknown) => void;
export type ReadBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Send a 308 Permanent Redirect with a Location header */
export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(308, { Location: location });
  res.end();
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const MAX_BODY = 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let bodySize = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
