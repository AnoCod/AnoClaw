/**
 * Bundles all CSS files in src/public/css/ into a single bundle.css.
 * Order: theme.css first (CSS variables), then layout-*.css alphabetically,
 * then any remaining files.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_DIR = 'src/public/css';
const OUT_FILE = 'src/public/css/bundle.css';

const files = readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));

// Priority order for CSS cascade
const FIRST = ['theme.css', 'layout-core.css', 'layout-motion.css'];
const ordered = [
  ...FIRST.filter(f => files.includes(f)),
  ...files.filter(f => !FIRST.includes(f) && f.startsWith('layout-')).sort(),
  ...files.filter(f => !FIRST.includes(f) && !f.startsWith('layout-') && f !== 'bundle.css').sort(),
];

let total = 0;
const out = ordered.map(name => {
  const content = readFileSync(join(CSS_DIR, name), 'utf-8');
  total += content.length;
  return `/* ${name} */\n${content}`;
}).join('\n\n');

writeFileSync(OUT_FILE, out);
console.log(`CSS bundle: ${ordered.length} files → bundle.css (${(total / 1024).toFixed(1)} KB)`);
