#!/usr/bin/env node
/**
 * check-module-boundaries.js
 *
 * Scans src/server/core/ for cross-module direct file imports.
 * A violation is when a file in moduleA/ imports from moduleB/Something.js
 * instead of moduleB/index.js.
 *
 * Existing debt is recorded in config/module-boundaries-baseline.json.
 * The default command fails when a new direct cross-module import is added.
 * Run with --update-baseline only after an intentional architecture review.
 */

const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'src', 'server', 'core');
const BASELINE_FILE = path.join(__dirname, '..', 'config', 'module-boundaries-baseline.json');
const MODULES = fs.readdirSync(CORE_DIR).filter(f => {
  const full = path.join(CORE_DIR, f);
  return fs.statSync(full).isDirectory() && !f.startsWith('_') && !f.startsWith('.');
});

// Modules that have index.ts
const MODULES_WITH_INDEX = MODULES.filter(m => {
  return fs.existsSync(path.join(CORE_DIR, m, 'index.ts'));
});

// Skip these import patterns (infra/, shared/, node builtins, same-module)
function isSkipped(importPath, currentModule) {
  if (importPath.startsWith('.')) {
    // Same-module relative imports OK (./Foo or ../../sameModule/)
    // We only flag cross-module direct file imports
  }
  return false;
}

const violations = [];

for (const mod of MODULES_WITH_INDEX) {
  const modDir = path.join(CORE_DIR, mod);
  const files = walkDir(modDir).filter(f => f.endsWith('.ts') && !f.endsWith('index.ts') && !f.includes('__tests__'));

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const importRegex = /from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      // Only check relative imports that cross module boundaries
      if (!importPath.startsWith('.')) continue;
      if (importPath.includes('node_modules')) continue;
      if (importPath.includes('/infra/')) continue; // infra is outside core/

      // Extract target module from path
      const parts = importPath.split('/');
      for (let i = 0; i < parts.length; i++) {
        if (MODULES_WITH_INDEX.includes(parts[i]) && parts[i] !== mod) {
          // Found a cross-module import
          const targetMod = parts[i];
          const lastPart = parts[parts.length - 1];
          // Only flag if importing a specific file, not the module's index
          if (lastPart !== 'index.js' && importPath !== `../${targetMod}/index.js` && importPath !== `../../${targetMod}/index.js`) {
            const relPath = path.relative(CORE_DIR, file);
            violations.push({
              id: `${relPath.replace(/\\/g, '/')} -> ${targetMod}/${lastPart}`,
              message: `${relPath} imports '../.../../${targetMod}/${lastPart}' — should go through '${targetMod}/index.js'`,
            });
          }
          break;
        }
      }
    }
  }
}

function walkDir(dir) {
  const results = [];
  const list = fs.readdirSync(dir);
  for (const f of list) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory() && !f.startsWith('_') && !f.startsWith('.')) {
      results.push(...walkDir(full));
    } else if (stat.isFile()) {
      results.push(full);
    }
  }
  return results;
}

violations.sort((a, b) => a.id.localeCompare(b.id));

if (process.argv.includes('--update-baseline')) {
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    version: 1,
    violations: violations.map(violation => violation.id),
  }, null, 2) + '\n', 'utf8');
  console.log(`Updated module boundary baseline with ${violations.length} known violation(s).`);
  process.exit(0);
}

let baseline;
try {
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  baseline = new Set(Array.isArray(parsed.violations) ? parsed.violations : []);
} catch (error) {
  console.error(`Cannot read module boundary baseline: ${error.message}`);
  process.exit(1);
}

const newViolations = violations.filter(violation => !baseline.has(violation.id));
const resolvedCount = [...baseline].filter(id => !violations.some(violation => violation.id === id)).length;

if (newViolations.length === 0) {
  if (violations.length === 0) {
    console.log('All cross-module imports go through index.ts.');
  } else {
    console.log(`Module boundary gate passed: ${violations.length} known violation(s), 0 new.`);
    if (resolvedCount > 0) console.log(`${resolvedCount} baseline violation(s) were resolved; update the baseline after review.`);
  }
} else {
  console.error(`${newViolations.length} new module boundary violation(s):`);
  newViolations.forEach(violation => console.error('  - ' + violation.message));
  process.exit(1);
}
