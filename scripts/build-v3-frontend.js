import { build } from 'esbuild';

await build({
  entryPoints: ['src/public/v3/main.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  outfile: 'src/public/js/v3-shell.js',
  sourcemap: true,
  minify: false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
});
