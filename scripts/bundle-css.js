/**
 * Bundles all CSS files in src/public/css/ into a single bundle.css.
 * Order: theme.css first (CSS variables), then layout-*.css alphabetically,
 * then any remaining files.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_DIR = 'src/public/css';
const OUT_FILE = 'src/public/css/bundle.css';

const BUNDLE_EXCLUDES = new Set([
  'bundle.css',
  // Plugin iframe skins are injected into sandboxed plugin pages by PluginPageContainer.
  'plugin-comfyui.css',
]);

const files = readdirSync(CSS_DIR).filter(f => f.endsWith('.css') && !BUNDLE_EXCLUDES.has(f));

// Priority order for CSS cascade
const FIRST = ['theme.css', 'layout-core.css', 'layout-motion.css'];
const ordered = [
  ...FIRST.filter(f => files.includes(f)),
  ...files.filter(f => !FIRST.includes(f) && f.startsWith('layout-')).sort(),
  ...files.filter(f => !FIRST.includes(f) && !f.startsWith('layout-')).sort(),
];

let total = 0;
const out = ordered.map(name => {
  const content = readFileSync(join(CSS_DIR, name), 'utf-8').replace(/^\uFEFF/, '');
  total += content.length;
  return `/* ${name} */\n${content}`;
}).join('\n\n');

writeFileSync(OUT_FILE, out);
console.log(`CSS bundle: ${ordered.length} files → bundle.css (${(total / 1024).toFixed(1)} KB)`);
