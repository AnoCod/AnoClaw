// WritablePath.ts — resolves paths to writable directories when packaged with asar.
// When asar packages the app, writable dirs (data/, config/, plugins/) are unpacked
// to app.asar.unpacked/. This helper routes writes there while keeping reads in asar.

import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as fs from 'fs';

/** The app root inside the asar (or real filesystem when asar:false).
 *  We're at dist/server/infra/ — need 3 levels up to reach the asar root. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The unpacked root — only non-null when running inside an asar archive. */
const UNPACKED_ROOT = (() => {
  const root = APP_ROOT.replace(/\\/g, '/');
  const asarIdx = root.indexOf('.asar');
  if (asarIdx < 0) return null;
  return root.substring(0, asarIdx) + '.asar.unpacked';
})();

/** Resolve a path that needs write access.
 *  Inside asar: routes to app.asar.unpacked/<segments>.
 *  Outside asar: resolves relative to APP_ROOT (same as process.cwd()). */
export function writablePath(...segments: string[]): string {
  return path.resolve(UNPACKED_ROOT || APP_ROOT, ...segments);
}

/** Resolve a path for reading (always inside the asar/app root). */
export function appPath(...segments: string[]): string {
  return path.resolve(APP_ROOT, ...segments);
}

/** Ensure a writable directory exists, creating it recursively if needed. */
export function ensureWritableDir(...segments: string[]): string {
  const dir = writablePath(...segments);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
