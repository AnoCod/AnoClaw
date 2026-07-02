#!/usr/bin/env node
/**
 * check-module-boundaries.js
 *
 * Scans src/server/core/ for cross-module direct file imports.
 * A violation is when a file in moduleA/ imports from moduleB/Something.js
 * instead of moduleB/index.js.
 *
 * Run: node scripts/check-module-boundaries.js
 * Add as pre-build step in package.json if desired.
 */

const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'src', 'server', 'core');
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
            violations.push(`${relPath} imports '../.../../${targetMod}/${lastPart}' — should go through '${targetMod}/index.js'`);
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

if (violations.length === 0) {
  console.log('All cross-module imports go through index.ts.');
  process.exit(0);
} else {
  console.log(`${violations.length} boundary violation(s) remaining (informational only — not enforced):`);
  violations.forEach(v => console.log('  - ' + v));
  process.exit(0); // Always pass — this is a lint, not a gate
}
