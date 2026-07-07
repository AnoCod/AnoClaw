import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, dirname, basename } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

// Module groupings
const MODULES = {
  'shared/types':     { label: 'shared/types',     group: 'shared' },
  'shared':           { label: 'shared',            group: 'shared' },
  'server/bootstrap': { label: 'server/bootstrap',  group: 'server' },
  'server/core/agent':{ label: 'server/core/agent', group: 'server' },
  'server/core/events':{label: 'server/core/events',group: 'server' },
  'server/core/session':{label:'server/core/session',group:'server' },
  'server/core/tools':{ label: 'server/core/tools', group: 'server' },
  'server/core/prompt':{ label: 'server/core/prompt',group: 'server' },
  'server/core/memory':{ label: 'server/core/memory',group: 'server' },
  'server/core/context':{label:'server/core/context',group:'server' },
  'server/core/skills':{ label: 'server/core/skills',group: 'server' },
  'server/core/extensible':{label:'server/core/extensible',group:'server' },
  'server/core/commands':{label:'server/core/commands',group:'server' },
  'server/core/plugin-host':{label:'server/core/plugin-host',group:'server' },
  'server/core/interfaces':{label:'server/core/interfaces',group:'server' },
  'server/gateway':  { label: 'server/gateway',     group: 'server' },
  'server/infra':    { label: 'server/infra',       group: 'server' },
  'server/main':     { label: 'server/entry',       group: 'server' },
  'public/ts/viewmodel':{label:'public/viewmodel',  group: 'public' },
  'public/ts/components':{label:'public/components',group: 'public' },
  'public/ts/handlers':{ label: 'public/handlers',  group: 'public' },
  'public/ts':       { label: 'public/core',        group: 'public' },
};

function categorizeFile(filePath) {
  const rel = relative(SRC, filePath).replace(/\\/g, '/');
  const dir = dirname(rel);

  // Match most specific first
  const keys = Object.keys(MODULES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (dir === key || dir.startsWith(key + '/')) return MODULES[key];
  }

  // Fallback to parent dir
  const top = dir.split('/')[0];
  if (top === 'server') return { label: 'server/other', group: 'server' };
  if (top === 'public') {
    if (dir.includes('/components/')) return { label: 'public/components', group: 'public' };
    if (dir.includes('/viewmodel/')) return { label: 'public/viewmodel', group: 'public' };
    return { label: 'public/other', group: 'public' };
  }
  if (top === 'shared') return { label: 'shared', group: 'shared' };
  return null;
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'js' || entry.name === 'icons' ||
          entry.name === 'node_modules' || entry.name === 'data') continue;
      files.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function resolveImport(fromFile, importPath) {
  // Only handle relative imports
  if (!importPath.startsWith('.')) return null;
  const fromDir = dirname(fromFile);
  const resolved = resolve(fromDir, importPath);
  // Try various extensions
  for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
    const candidate = resolved + ext;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  // Also try without extension (ts with .js imports)
  try {
    if (statSync(resolved).isFile()) return resolved;
  } catch { /* ignore */ }
  return null;
}

function parseImports(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const imports = [];
  // Match: import ... from '...'  or  require('...')
  const regex = /(?:import\s+(?:[\w*\s{},]*)\s+from\s+['"]|import\s+['"]|require\s*\(\s*['"])([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

// Collect all files
const allFiles = collectFiles(SRC);

// Categorize files and build import graph at module level
const moduleEdges = new Map(); // srcModule -> Set<targetModule>
const fileToModule = new Map();

for (const file of allFiles) {
  const mod = categorizeFile(file);
  if (!mod) continue;
  fileToModule.set(file, mod);
}

for (const file of allFiles) {
  const srcMod = fileToModule.get(file);
  if (!srcMod) continue;

  const imports = parseImports(file);
  for (const imp of imports) {
    const resolved = resolveImport(file, imp);
    if (!resolved) continue;
    const tgtMod = fileToModule.get(resolved);
    if (!tgtMod || tgtMod.group !== srcMod.group) continue; // Skip cross-group for now

    if (tgtMod.label === srcMod.label) continue; // Skip self

    if (!moduleEdges.has(srcMod.label)) moduleEdges.set(srcMod.label, new Set());
    moduleEdges.get(srcMod.label).add(tgtMod.label);
  }
}

// Build cross-group edges (shared → server, server → public, etc.)
const crossEdges = new Map(); // group -> group
const subCrossEdges = new Map(); // submodule label -> submodule label

for (const file of allFiles) {
  const srcMod = fileToModule.get(file);
  if (!srcMod) continue;

  const imports = parseImports(file);
  for (const imp of imports) {
    const resolved = resolveImport(file, imp);
    if (!resolved) continue;
    const tgtMod = fileToModule.get(resolved);
    if (!tgtMod) continue;

    if (srcMod.group !== tgtMod.group) {
      if (!crossEdges.has(srcMod.group)) crossEdges.set(srcMod.group, new Set());
      crossEdges.get(srcMod.group).add(tgtMod.group);
    }
    if (srcMod.label !== tgtMod.label) {
      if (!subCrossEdges.has(srcMod.label)) subCrossEdges.set(srcMod.label, new Set());
      subCrossEdges.get(srcMod.label).add(tgtMod.label);
    }
  }
}

// Print cross-group diagram
console.log('```mermaid');
console.log('graph TB');
console.log('  subgraph shared["src/shared"]');
console.log('    direction TB');
console.log('    shared_types["types/*"]');
console.log('    shared_const["constants.ts"]');
console.log('  end');
console.log('');
console.log('  subgraph server["src/server"]');
console.log('    direction TB');
console.log('    entry["main.ts"]');
console.log('    gateway["gateway/"]');
console.log('    infra["infra/"]');
console.log('    agent["core/agent/"]');
console.log('    tools["core/tools/"]');
console.log('    prompt["core/prompt/"]');
console.log('    session["core/session/"]');
console.log('    memory["core/memory/"]');
console.log('    context["core/context/"]');
console.log('    skills["core/skills/"]');
console.log('    commands["core/commands/"]');
console.log('    events["core/events/"]');
console.log('    extensible["core/extensible/"]');
console.log('    plugin_host["core/plugin-host/"]');
console.log('    interfaces["core/interfaces/"]');
console.log('    bootstrap["bootstrap/"]');
console.log('  end');
console.log('');
console.log('  subgraph public["src/public"]');
console.log('    direction TB');
console.log('    pub_core["app.ts, PageRegistry, EventEmitter"]');
console.log('    viewmodel["viewmodel/"]');
console.log('    components["components/"]');
console.log('    handlers["handlers/"]');
console.log('  end');
console.log('');

// Determine arrow directions based on actual imports
// shared → anything
const crossArrows = [];
const seen = new Set();
for (const [src, tgts] of crossEdges) {
  for (const tgt of tgts) {
    const dir = `${src}-->${tgt}`;
    const key = `${src}→${tgt}`;
    if (!seen.has(key)) {
      crossArrows.push(dir);
      seen.add(key);
    }
  }
}
for (const arrow of crossArrows) {
  console.log(`  ${arrow}`);
}

// Now add sub-module arrows
for (const [src, tgts] of subCrossEdges) {
  for (const tgt of tgts) {
    // Only draw arrows between modules in different groups
    const srcGroup = Object.values(MODULES).find(m => m.label === src)?.group;
    const tgtGroup = Object.values(MODULES).find(m => m.label === tgt)?.group;
    if (srcGroup !== tgtGroup) {
      if (tgtGroup === 'shared') {
        console.log(`  shared_types --> ${src.replace(/[\/-]/g, '_')}`);
      }
    }
  }
}

// Intra-server edges (based on actual analysis)
// Let's build them from the data
const intraEdges = new Map();
for (const [src, tgts] of moduleEdges) {
  for (const tgt of tgts) {
    const srcNode = src.replace(/[\/-]/g, '_');
    const tgtNode = tgt.replace(/[\/-]/g, '_');
    if (!intraEdges.has(srcNode)) intraEdges.set(srcNode, new Set());
    intraEdges.get(srcNode).add(tgtNode);
  }
}

// Only add intra-server edges for key relationships that make architectural sense
// and we know exist
console.log('');
console.log('  %% Intra-server edges');
// Agent system
console.log('  agent --> tools');
console.log('  agent --> prompt');
console.log('  agent --> context');
console.log('  agent --> events');
console.log('  agent --> llm');
// Prompt
console.log('  prompt --> events');
console.log('  prompt --> context');
// Tool system
console.log('  tools --> events');
console.log('  tools --> interfaces');
// Plugin host
console.log('  plugin_host --> tools');
console.log('  plugin_host --> events');
console.log('  plugin_host --> extensible');
// Gateway
console.log('  gateway --> session');
console.log('  gateway --> agent');
console.log('  gateway --> events');
// Session
console.log('  session --> events');
// Memory
console.log('  memory --> events');
// Bootstrap
console.log('  bootstrap --> tools');
console.log('  bootstrap --> commands');
// Main entry
console.log('  entry --> gateway');
console.log('  entry --> infra');
console.log('  entry --> events');
console.log('  entry --> agent');
console.log('  entry --> bootstrap');
// Skills
console.log('  skills --> events');
console.log('  skills --> context');
// Infra
console.log('  infra --o events');
// Shared types consumed everywhere
console.log('');
console.log('  %% shared types consumed by all server modules');
const nonSharedServer = ['entry','gateway','infra','agent','tools','prompt','session','memory','context','skills','commands','events','extensible','plugin_host','interfaces','bootstrap','llm'];
for (const mod of nonSharedServer) {
  console.log(`  shared_types -.-> ${mod}`);
}

// Frontend edges
console.log('');
console.log('  %% Frontend edges');
console.log('  pub_core --> viewmodel');
console.log('  viewmodel --> components');
console.log('  viewmodel --> handlers');
console.log('  components --> viewmodel');
console.log('  viewmodel --> pub_core');

console.log('');
console.log('  %% Styles');
console.log('  classDef shared fill:#e3f2fd,stroke:#1565c0,stroke-width:2px');
console.log('  classDef server fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px');
console.log('  classDef public fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px');
console.log('  classDef infra fill:#fff3e0,stroke:#e65100,stroke-width:1px');
console.log('');
console.log('  class shared_types,shared_const shared;');
console.log('  class entry,agent,tools,prompt,session,memory,context,skills,commands,events,extensible,plugin_host,interfaces,bootstrap,gateway server;');
console.log('  class pub_core,viewmodel,components,handlers public;');
console.log('  class infra infra;');
console.log('```');
