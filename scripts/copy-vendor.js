// Bundle/copy browser vendor assets used by the frontend and plugin iframes.
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

await build({
  bundle: true,
  format: 'iife',
  globalName: 'd3',
  outfile: 'src/public/d3-force.min.js',
  minify: true,
  entryPoints: ['node_modules/d3-force/src/index.js'],
});
console.log('d3-force bundled to src/public/d3-force.min.js');

const vendorDir = 'src/public/vendor';
fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(
  path.join('node_modules', 'jszip', 'dist', 'jszip.min.js'),
  path.join(vendorDir, 'jszip.min.js'),
);
console.log('JSZip copied to src/public/vendor/jszip.min.js');
