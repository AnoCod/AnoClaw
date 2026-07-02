// Bundle d3-force into a single IIFE file (replaces old cytoscape copy step)
import { build } from 'esbuild';

await build({
  bundle: true,
  format: 'iife',
  globalName: 'd3',
  outfile: 'src/public/d3-force.min.js',
  minify: true,
  entryPoints: ['node_modules/d3-force/src/index.js'],
});
console.log('d3-force bundled to src/public/d3-force.min.js');
