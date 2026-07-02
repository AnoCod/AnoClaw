// Build plugin frontend bundles using esbuild.
// Each plugin with frontend/src/main.ts gets compiled to frontend/bundle.js
// Run: node scripts/build-plugin-frontends.js

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pluginsDir = path.resolve(__dirname, '..', 'plugins');
if (!fs.existsSync(pluginsDir)) {
  console.log('No plugins directory — skipping plugin frontend build.');
  process.exit(0);
}
const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_') && !d.name.startsWith('shared'))
  .map(d => {
    const src = path.join(pluginsDir, d.name, 'frontend', 'src', 'main.ts');
    return { name: d.name, src, exists: fs.existsSync(src) };
  })
  .filter(e => e.exists);

if (entries.length === 0) {
  console.log('No plugin frontend sources found.');
  process.exit(0);
}

(async () => {
  for (const entry of entries) {
    const outfile = path.join(pluginsDir, entry.name, 'frontend', 'bundle.js');
    console.log(`Building ${entry.name}...`);
    try {
      await esbuild.build({
        entryPoints: [entry.src],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        outfile,
        minify: false,
        sourcemap: false,
        logLevel: 'warning',
      });
      const size = (fs.statSync(outfile).size / 1024).toFixed(1);
      console.log(`  ${entry.name}: ${outfile} (${size} KB)`);
    } catch (err) {
      console.error(`  ${entry.name} FAILED: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`Done. ${entries.length} plugin frontends built.`);
})();
