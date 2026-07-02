// StaticFiles — MIME type map and static file serving utility
// Serves frontend assets (HTML, CSS, JS, SVG, etc.) from the public directory.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

/** MIME type mapping for common static file extensions */
export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * Serve a static file from the public directory.
 * Sanitizes the path to prevent directory traversal, then reads and streams
 * the file with the correct Content-Type header.
 */
export function serveStatic(res: http.ServerResponse, urlPath: string, publicDir: string): void {
  const safePath = urlPath === '/' || urlPath === '' ? 'index.html'
    : path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[\/\\]+/, '');
  const filePath = path.join(publicDir, safePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}
