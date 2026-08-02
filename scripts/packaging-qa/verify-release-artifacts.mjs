#!/usr/bin/env node

import { extractFile, listPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  detectSecretLiteral,
  expectedReleaseArtifactNames,
  sha256File,
} from './qualification-lib.mjs';

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.toml', '.txt', '.xml', '.yaml', '.yml',
]);
const APP_OWNED_PREFIXES = ['/dist/', '/docs/', '/plugins/', '/skills/', '/src/public/'];
const MAX_SCANNED_TEXT_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const options = { releaseDir: 'release9' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--release-dir') options.releaseDir = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function normalizeAsarEntry(entry) {
  return `/${String(entry).replace(/^[/\\]+/, '').replace(/\\/g, '/')}`;
}

function assertFile(filePath, label, minimumBytes = 1) {
  const info = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new Error(`${label} is missing: ${filePath}`);
  if (info.size < minimumBytes) throw new Error(`${label} is unexpectedly small (${info.size} bytes): ${filePath}`);
  return info.size;
}

function assertDirectory(directory, label) {
  const info = fs.statSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory()) throw new Error(`${label} is missing: ${directory}`);
}

function rootDirectoryContainsFiles(directory) {
  if (!fs.existsSync(directory)) return false;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) return true;
    }
  }
  return false;
}

function inspectAsar(asarPath) {
  const entries = listPackage(asarPath).map(normalizeAsarEntry);
  const unpackedRoot = path.resolve(`${asarPath}.unpacked`);
  const forbiddenEntries = entries.filter((entry) => {
    const lower = entry.toLowerCase();
    const base = path.posix.basename(lower);
    return lower.startsWith('/config/')
      || lower === '/config'
      || lower.startsWith('/data/')
      || lower === '/data'
      || lower.startsWith('/src/public/ts/')
      || lower.endsWith('.map')
      || lower.includes('/docs/待修复问题点')
      || base === 'agents.md'
      || base === 'claude.md'
      || /^claude\..+\.md$/.test(base);
  });
  if (forbiddenEntries.length > 0) {
    throw new Error(`Forbidden package entries detected:\n${forbiddenEntries.slice(0, 30).join('\n')}`);
  }

  const secretFindings = [];
  let scannedAppOwnedFiles = 0;
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (!APP_OWNED_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (!TEXT_EXTENSIONS.has(path.posix.extname(lower))) continue;
    let content;
    try {
      const unpackedPath = path.resolve(unpackedRoot, entry.slice(1));
      const relative = path.relative(unpackedRoot, unpackedPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`unsafe archive entry path: ${entry}`);
      }
      const unpackedInfo = fs.statSync(unpackedPath, { throwIfNoEntry: false });
      const buffer = unpackedInfo?.isFile()
        ? fs.readFileSync(unpackedPath)
        : extractFile(asarPath, path.normalize(entry.slice(1)));
      if (buffer.byteLength > MAX_SCANNED_TEXT_BYTES) continue;
      content = buffer.toString('utf8');
    } catch (error) {
      throw new Error(`Cannot inspect packaged text file ${entry}: ${error.message}`);
    }
    scannedAppOwnedFiles++;
    const patterns = detectSecretLiteral(content);
    if (patterns.length > 0) secretFindings.push({ entry, patterns });
  }
  if (secretFindings.length > 0) {
    const summary = secretFindings
      .slice(0, 30)
      .map((finding) => `${finding.entry}: ${finding.patterns.join(', ')}`)
      .join('\n');
    throw new Error(`Credential-like literals detected in package-owned files:\n${summary}`);
  }

  return { entryCount: entries.length, scannedAppOwnedFiles };
}

function currentCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/packaging-qa/verify-release-artifacts.mjs [--release-dir release9]');
    return;
  }

  const repoRoot = process.cwd();
  const releaseDir = path.resolve(repoRoot, options.releaseDir);
  const packageJson = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const names = expectedReleaseArtifactNames(packageJson.version);
  const installerPath = path.join(releaseDir, names.installer);
  const portablePath = path.join(releaseDir, names.portable);
  const resourcesRoot = path.join(releaseDir, 'win-unpacked', 'resources');
  const asarPath = path.join(resourcesRoot, 'app.asar');
  const unpackedRoot = path.join(resourcesRoot, 'app.asar.unpacked');

  const sizes = {
    installer: assertFile(installerPath, 'NSIS installer', 10 * 1024 * 1024),
    portable: assertFile(portablePath, 'portable ZIP', 10 * 1024 * 1024),
    asar: assertFile(asarPath, 'app.asar', 1024),
  };
  for (const directory of ['dist', 'plugins', 'skills', 'docs', 'node_modules']) {
    assertDirectory(path.join(unpackedRoot, directory), `unpacked ${directory}`);
  }
  for (const runtimeDirectory of ['config', 'data']) {
    const candidate = path.join(unpackedRoot, runtimeDirectory);
    if (rootDirectoryContainsFiles(candidate)) {
      throw new Error(`Runtime ${runtimeDirectory} leaked into package: ${candidate}`);
    }
  }

  const asar = inspectAsar(asarPath);
  const hashes = {
    [names.installer]: await sha256File(installerPath),
    [names.portable]: await sha256File(portablePath),
  };
  const manifest = {
    product: packageJson.productName || 'AnoClaw',
    version: packageJson.version,
    commit: currentCommit(),
    generatedAt: new Date().toISOString(),
    artifacts: [
      { name: names.installer, bytes: sizes.installer, sha256: hashes[names.installer], kind: 'nsis' },
      { name: names.portable, bytes: sizes.portable, sha256: hashes[names.portable], kind: 'zip' },
    ],
    packageInspection: {
      asarBytes: sizes.asar,
      asarEntries: asar.entryCount,
      scannedAppOwnedFiles: asar.scannedAppOwnedFiles,
      runtimeDataPresent: false,
      runtimeConfigPresent: false,
      sourceMapsPresent: false,
      credentialLiteralsPresent: false,
    },
  };

  await fsp.writeFile(
    path.join(releaseDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(releaseDir, 'SHA256SUMS.txt'),
    `${Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`,
    'utf8',
  );

  console.log(JSON.stringify({
    ok: true,
    releaseDir,
    version: packageJson.version,
    artifacts: manifest.artifacts.map(({ name, bytes, kind }) => ({ name, bytes, kind })),
    packageInspection: manifest.packageInspection,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[release-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
