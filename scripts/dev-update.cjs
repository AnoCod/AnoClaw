#!/usr/bin/env node
/**
 * dev-update.cjs
 *
 * Hot-replaces AnoClaw app files in the installed directory (D:/ANOCLAW)
 * without touching data/, config/, or the user's data.
 *
 * Prerequisites: release9 has already been built (npx electron-builder --win).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INSTALL_DIR = process.env.ANOCLAW_INSTALL_DIR || 'D:/ANOCLAW';
const RELEASE_DIR = process.env.ANOCLAW_RELEASE_DIR || 'release9/win-unpacked';

function copyDir(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) { copyDir(sp, dp); }
    else { try { fs.unlinkSync(dp); } catch {}; fs.copyFileSync(sp, dp); }
  }
}

function syncUnpacked(srcUnpacked, dstUnpacked) {
  if (!fs.existsSync(dstUnpacked)) fs.mkdirSync(dstUnpacked, { recursive: true });

  // Runtime/build output is release-owned and can be replaced wholesale.
  for (const dir of ['dist', 'node_modules', 'docs']) {
    const sp = path.join(srcUnpacked, dir);
    const dp = path.join(dstUnpacked, dir);
    if (!fs.existsSync(sp)) continue;
    try { fs.rmSync(dp, { recursive: true, force: true }); } catch {}
    copyDir(sp, dp);
    console.log('  app.asar.unpacked/' + dir + ' OK');
  }

  // Plugins and skills are user-extensible. Merge shipped updates in place so
  // custom entries and plugin-owned data directories are never removed.
  for (const dir of ['plugins', 'skills']) {
    const sp = path.join(srcUnpacked, dir);
    const dp = path.join(dstUnpacked, dir);
    if (!fs.existsSync(sp)) continue;
    copyDir(sp, dp);
    console.log('  app.asar.unpacked/' + dir + ' merged (user content preserved)');
  }
}

function main() {
  // 1. Kill running instances
  console.log('[dev-update] Killing running AnoClaw...');
  try {
    execSync('pwsh -NoProfile -Command "Get-Process -Name \'AnoClaw\',\'electron\' -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'pipe' });
  } catch { /* ok */ }

  // 2. Verify source and target exist
  const srcAsar = path.join(RELEASE_DIR, 'resources', 'app.asar');
  if (!fs.existsSync(srcAsar)) {
    console.error('[dev-update] ERROR: app.asar not found. Build output first: ' + RELEASE_DIR);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(INSTALL_DIR)) {
    console.error('[dev-update] ERROR: Install dir not found: ' + INSTALL_DIR);
    process.exitCode = 1;
    return;
  }

  // 3. Replace app.asar
  const dstAsar = path.join(INSTALL_DIR, 'resources', 'app.asar');
  console.log('[dev-update] Replacing app.asar...');
  try { fs.unlinkSync(dstAsar); } catch {}
  fs.copyFileSync(srcAsar, dstAsar);
  console.log('  app.asar OK');

  // 4. Replace release-owned unpacked content and merge user-extensible content.
  syncUnpacked(
    path.join(RELEASE_DIR, 'resources', 'app.asar.unpacked'),
    path.join(INSTALL_DIR, 'resources', 'app.asar.unpacked'),
  );

  console.log('');
  console.log(`[dev-update] Done. Double-click ${path.join(INSTALL_DIR, 'AnoClaw.exe')} to test.`);
  console.log('  Sessions, agents, plugins, skills, and settings are preserved.');
}

if (require.main === module) main();

module.exports = { copyDir, syncUnpacked };
