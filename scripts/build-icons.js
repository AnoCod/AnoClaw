// Build icon: SVG → PNG → ICO
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Resvg } from '@resvg/resvg-js';

const sizes = [16, 32, 48, 64, 128, 256];

async function buildIcons() {
  const svg = readFileSync(resolve('build/icon.svg'), 'utf-8');

  // Generate PNGs at all sizes
  const pngBuffers = [];
  for (const size of sizes) {
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' });
    const png = resvg.render().asPng();
    pngBuffers.push(Buffer.from(png));
    if (size === 256) {
      writeFileSync(resolve('build/icon.png'), png);
    }
    console.log(`  ${size}x${size} ✓`);
  }

  // Generate ICO from all sizes
  const { default: pngToIco } = await import('png-to-ico');
  const ico = await pngToIco(pngBuffers);
  writeFileSync(resolve('build/icon.ico'), ico);
  console.log(`  icon.ico ✓ (${ico.length} bytes)`);
}

mkdirSync(resolve('build'), { recursive: true });
buildIcons().catch(console.error);
