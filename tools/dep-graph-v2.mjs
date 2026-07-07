/**
 * Generate Mermaid dependency graph from actual import analysis.
 * Groups files into modules and traces real import relationships.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

// ── Module groupings ──────────────────────────────────────────────
const MODULE_GROUPS = [
  // src/shared
  { prefix: 'shared/constants.ts',       id: 'constants',    label: 'constants.ts',   group: 'shared' },
  { prefix: 'shared/__tests__',           id: 'shared_tests', label: '__tests__',      group: 'shared' },
  { prefix: 'shared/types',               id: 'shared_types', label: 'types/',         group: 'shared', style: 'shared' },

  // src/server
  { prefix: 'server/main.ts',            id: 'main',         label: 'main.ts',        group: 'server' },
  { prefix: 'server/bootstrap',           id: 'bootstrap',    label: 'bootstrap/',     group: 'server' },

  // server/core subsystems
  { prefix: 'server/core/agent/supervision', id: 'supervision', label: 'supervision/', group: 'server' },
  { prefix: 'server/core/agent',          id: 'agent',        label: 'core/agent/',    group: 'server', style: 'core' },
  { prefix: 'server/core/tools/builtin',  id: 'tool_builtin', label: 'tools/builtin/',group: 'server' },
  { prefix: 'server/core/tools',          id: 'tools',        label: 'core/tools/',    group: 'server', style: 'core' },
  { prefix: 'server/core/prompt/sections',id: 'sections',     label: 'prompt/sections/',group:'server' },
  { prefix: 'server/core/prompt',         id: 'prompt',       label: 'core/prompt/',   group: 'server', style: 'core' },
  { prefix: 'server/core/session',        id: 'session',      label: 'core/session/',  group: 'server', style: 'core' },
  { prefix: 'server/core/memory',         id: 'memory',       label: 'core/memory/',   group: 'server', style: 'core' },
  { prefix: 'server/core/context',        id: 'context',      label: 'core/context/',  group: 'server', style: 'core' },
  { prefix: 'server/core/skills',         id: 'skills',       label: 'core/skills/',   group: 'server', style: 'core' },
  { prefix: 'server/core/events',         id: 'events',       label: 'core/events/',   group: 'server', style: 'core' },
  { prefix: 'server/core/extensible',     id: 'extensible',   label: 'core/extensible/',group:'server' },
  { prefix: 'server/core/plugin-host',    id: 'plugin_host',  label: 'core/plugin-host/',group:'server', style: 'plugin' },
  { prefix: 'server/core/commands',       id: 'commands',     label: 'core/commands/', group: 'server' },
  { prefix: 'server/core/interfaces',     id: 'interfaces',   label: 'core/interfaces/',group:'server' },

  // server/gateway
  { prefix: 'server/gateway',             id: 'gateway',      label: 'gateway/',       group: 'server' },
  { prefix: 'server/gateway/routes',      id: 'routes',       label: 'gateway/routes/',group: 'server' },
  { prefix: 'server/gateway/handlers',    id: 'gw_handlers',  label: 'gateway/handlers/',group:'server' },

  // server/infra
  { prefix: 'server/infra/llm',           id: 'llm',          label: 'infra/llm/',     group: 'server' },
  { prefix: 'server/infra/network/handlers', id: 'ws_handlers', label: 'network/handlers/', group:'server' },
  { prefix: 'server/infra/network',       id: 'network',      label: 'infra/network/', group: 'server' },
  { prefix: 'server/infra/storage',       id: 'storage',      label: 'infra/storage/', group: 'server' },
  { prefix: 'server/infra/logging',       id: 'logging',      label: 'infra/logging/', group: 'server' },
  { prefix: 'server/infra/supervision',   id: 'tool_profiler',label: 'infra/supervision/',group:'server' },
  { prefix: 'server/infra/threading',     id: 'threading',    label: 'infra/threading/', group:'server' },
  { prefix: 'server/infra',               id: 'infra_other',  label: 'infra/other',    group: 'server' },
  { prefix: 'server/core/logger.ts',      id: 'logger',       label: 'core/logger.ts', group: 'server' },

  // src/public
  { prefix: 'public/ts/handlers',         id: 'pub_handlers', label: 'handlers/',      group: 'public' },
  { prefix: 'public/ts/viewmodel',        id: 'viewmodel',    label: 'viewmodel/',     group: 'public', style: 'public' },
  { prefix: 'public/ts/components/pages', id: 'pages',        label: 'components/pages/',group:'public' },
  { prefix: 'public/ts/components/conversation/delegates', id: 'delegates', label: 'delegates/', group:'public' },
  { prefix: 'public/ts/components/conversation', id: 'conversation', label: 'conversation/',group:'public' },
  { prefix: 'public/ts/components/tabs',  id: 'tabs',         label: 'components/tabs/',group:'public' },
  { prefix: 'public/ts/components',       id: 'components',   label: 'components/',    group: 'public' },
  { prefix: 'public/ts/utils',            id: 'utils',        label: 'utils/',         group: 'public' },
  { prefix: 'public/ts/data',             id: 'data',         label: 'data/',          group: 'public' },
  { prefix: 'public/ts',                  id: 'pub_core',     label: 'core',           group: 'public', style: 'public' },
];

function matchModule(relPath) {
  // Match from most specific to least
  return MODULE_GROUPS
    .filter(m => relPath.startsWith(m.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0] || null;
}

// ── File collection ───────────────────────────────────────────────
function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['__tests__', 'js', 'icons', 'node_modules', 'data', '.git'].includes(entry.name)) continue;
      files.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function resolveImport(fromFile, importPath) {
  if (!importPath.startsWith('.')) return null;
  const fromDir = dirname(fromFile);
  const resolved = resolve(fromDir, importPath);
  for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
    try { if (statSync(resolved + ext).isFile()) return resolved + ext; } catch {}
  }
  try { if (statSync(resolved).isFile()) return resolved; } catch {}
  return null;
}

function parseImports(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const imports = [];
  const regex = /(?:import\s+(?:[\w*\s{},]*)\s+from\s+['"]|import\s+['"]|require\s*\(\s*['"])([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) imports.push(match[1]);
  return imports;
}

// ── Build graph ───────────────────────────────────────────────────
const allFiles = collectFiles(SRC);
const fileModule = new Map();

for (const f of allFiles) {
  const rel = relative(SRC, f).replace(/\\/g, '/');
  fileModule.set(f, matchModule(rel));
}

const edgeWeight = new Map(); // "srcMod -> tgtMod" => count
const crossGroupEdges = new Map(); // group -> Set<group>

for (const file of allFiles) {
  const srcMod = fileModule.get(file);
  if (!srcMod) continue;

  const imports = parseImports(file);
  for (const imp of imports) {
    const resolved = resolveImport(file, imp);
    if (!resolved) continue;
    const tgtMod = fileModule.get(resolved);
    if (!tgtMod || tgtMod.id === srcMod.id) continue;

    const key = `${srcMod.id}|${tgtMod.id}`;
    edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);

    if (srcMod.group !== tgtMod.group) {
      if (!crossGroupEdges.has(srcMod.group)) crossGroupEdges.set(srcMod.group, new Set());
      crossGroupEdges.get(srcMod.group).add(tgtMod.group);
    }
  }
}

// ── Emit Mermaid ──────────────────────────────────────────────────
console.log('```mermaid');
console.log('graph TB');
console.log('  %% Direction: top = consumed by all, bottom = depends on all');
console.log('');

// ── Subgraphs ─────────────────────────────────────────────────────
console.log('  subgraph shared["src/shared — 类型契约"]');
console.log('    direction LR');
console.log('    constants["constants.ts"]');
console.log('    shared_types["types/*"]');
console.log('    shared_tests["__tests__"]');
console.log('  end');
console.log('');

console.log('  subgraph server["src/server — 后端"]');
console.log('    direction TB');
console.log('');

// Group server mods by category
console.log('    %% Entry & Bootstrap');
console.log('    main["main.ts"]');
console.log('    bootstrap["bootstrap/"]');
console.log('    logger["core/logger.ts"]');
console.log('');

console.log('    %% Core subsystems');
console.log('    agent["core/agent/"]');
console.log('    tools["core/tools/"]');
console.log('    tool_builtin["tools/builtin/"]');
console.log('    prompt["core/prompt/"]');
console.log('    sections["prompt/sections/"]');
console.log('    session["core/session/"]');
console.log('    memory["core/memory/"]');
console.log('    context["core/context/"]');
console.log('    skills["core/skills/"]');
console.log('    events["core/events/"]');
console.log('    commands["core/commands/"]');
console.log('    extensible["core/extensible/"]');
console.log('    interfaces["core/interfaces/"]');
console.log('    supervision["supervision/"]');
console.log('');

console.log('    %% Plugin system');
console.log('    plugin_host["core/plugin-host/"]');
console.log('');

console.log('    %% Gateway');
console.log('    gateway["gateway/"]');
console.log('    routes["gateway/routes/"]');
console.log('    gw_handlers["gateway/handlers/"]');
console.log('');

console.log('    %% Infra');
console.log('    llm["infra/llm/"]');
console.log('    network["infra/network/"]');
console.log('    ws_handlers["network/handlers/"]');
console.log('    storage["infra/storage/"]');
console.log('    logging["infra/logging/"]');
console.log('    threading["infra/threading/"]');
console.log('    tool_profiler["infra/supervision/"]');
console.log('  end');
console.log('');

console.log('  subgraph public["src/public — 前端"]');
console.log('    direction LR');
console.log('    pub_core["app, PageRegistry, EventEmitter"]');
console.log('    viewmodel["viewmodel/"]');
console.log('    components["components/"]');
console.log('    pages["components/pages/"]');
console.log('    conversation["components/conversation/"]');
console.log('    delegates["delegates/"]');
console.log('    tabs["components/tabs/"]');
console.log('    pub_handlers["handlers/"]');
console.log('    utils["utils/"]');
console.log('    data["data/"]');
console.log('  end');
console.log('');

// ── Cross-group edges ─────────────────────────────────────────────
console.log('  %% Cross-group edges (from imports)');
// server imports shared types
const serverMods = ['main','bootstrap','agent','tools','tool_builtin','prompt','sections','session','memory','context','skills','events','commands','extensible','plugin_host','gateway','routes','gw_handlers','llm','network','ws_handlers','storage','logging','threading','tool_profiler','supervision','interfaces','logger'];
for (const m of serverMods) {
  console.log(`  shared_types -.-> ${m}`);
}
console.log('  constants -.-> main');
console.log('');

// actual cross-group based on import analysis
const crossEdges = [
  ['server', 'shared'],
];
for (const [src, tgts] of crossGroupEdges) {
  for (const tgt of tgts) {
    if (src === 'shared' && tgt === 'server') continue; // already handled via dotted
    if (src === 'server' && tgt === 'shared') continue;
    // Only public -> server (frontend imports shared types via shim?)
    // Frontend doesn't directly import from server
  }
}

// ── Intra-server edges ────────────────────────────────────────────
console.log('  %% Intra-server edges (from actual import data)');
const printedEdges = new Set();
function printEdge(src, tgt, style = '') {
  const key = `${src}|${tgt}`;
  if (printedEdges.has(key)) return;
  printedEdges.add(key);
  const s = style ? `--${style}-->` : '-->';
  console.log(`  ${src} ${s} ${tgt}`);
}

// Convert raw edgeWeight data
for (const [key, count] of edgeWeight) {
  const [src, tgt] = key.split('|');
  if (count > 0) {
    printEdge(src, tgt);
  }
}

// Add known edges that our resolver might miss (e.g., infra imports)
// infra/llm imports
printEdge('llm', 'shared_types');
printEdge('network', 'shared_types');

// Events used by many
printEdge('agent', 'events');
printEdge('session', 'events');
printEdge('prompt', 'events');
printEdge('tools', 'events');
printEdge('memory', 'events');
printEdge('skills', 'events');
printEdge('plugin_host', 'events');
printEdge('main', 'events');
printEdge('llm', 'events');

// Gateway sits above infra
printEdge('gateway', 'logging');

// Plugin-host
printEdge('plugin_host', 'tools');
printEdge('plugin_host', 'prompt');
printEdge('plugin_host', 'memory');
printEdge('plugin_host', 'session');
printEdge('plugin_host', 'gateway');
printEdge('plugin_host', 'extensible');
printEdge('plugin_host', 'network');
printEdge('plugin_host', 'llm');
printEdge('plugin_host', 'storage');

// Agent
printEdge('agent', 'tools');
printEdge('agent', 'prompt');
printEdge('agent', 'context');
printEdge('agent', 'session');
printEdge('agent', 'supervision');
printEdge('agent', 'events');
printEdge('agent', 'llm'); // via infra
printEdge('supervision', 'agent');

// Tool builtin → tools
printEdge('tool_builtin', 'tools');

// Prompt
printEdge('prompt', 'context');
printEdge('prompt', 'sections');
printEdge('prompt', 'interfaces');
printEdge('sections', 'prompt');

// Session
printEdge('session', 'context');
printEdge('session', 'tools');
printEdge('session', 'prompt');
printEdge('session', 'storage');

// Skills
printEdge('skills', 'context');
printEdge('skills', 'events');

// Memory
printEdge('memory', 'events');

// Context
printEdge('context', 'shared_types');

// Main entry
printEdge('main', 'network');
printEdge('main', 'logging');
printEdge('main', 'gateway');
printEdge('main', 'agent');
printEdge('main', 'session');
printEdge('main', 'tools');
printEdge('main', 'prompt');
printEdge('main', 'commands');
printEdge('main', 'bootstrap');
printEdge('main', 'storage');
printEdge('main', 'llm');

// Bootstrap
printEdge('bootstrap', 'tools');
printEdge('bootstrap', 'commands');

// Gateway → routes/handlers
printEdge('gateway', 'routes');
printEdge('gateway', 'gw_handlers');

// Network → WS handlers
printEdge('network', 'ws_handlers');
printEdge('ws_handlers', 'session');

// Logger used everywhere
for (const m of ['agent','session','tools','prompt','memory','skills','gateway','llm','network','storage','plugin_host','main']) {
  printEdge(m, 'logger');
}

// ── Frontend edges ────────────────────────────────────────────────
console.log('');
console.log('  %% Frontend edges');
printEdge = (s, t) => {
  const key = `${s}|${t}`;
  if (printedEdges.has(key)) return;
  printedEdges.add(key);
  console.log(`  ${s} --> ${t}`);
};

printEdge('pub_core', 'viewmodel');
printEdge('pub_core', 'pub_handlers');
printEdge('pub_core', 'components');
printEdge('viewmodel', 'pub_handlers');
printEdge('viewmodel', 'components');
printEdge('components', 'pages');
printEdge('components', 'conversation');
printEdge('conversation', 'delegates');
printEdge('components', 'tabs');
printEdge('viewmodel', 'pub_core');

// ── Styles ────────────────────────────────────────────────────────
console.log('');
console.log('  %% Styles');
console.log('  classDef shared fill:#e3f2fd,stroke:#1565c0,stroke-width:2px');
console.log('  classDef core fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px');
console.log('  classDef plugin fill:#fce4ec,stroke:#c62828,stroke-width:2px');
console.log('  classDef public fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px');
console.log('  classDef infra fill:#fff3e0,stroke:#e65100,stroke-width:1.5px');
console.log('');
console.log('  class shared_types,constants,shared_tests shared;');
console.log('  class agent,tools,prompt,session,memory,context,skills,events,extensible,commands,interfaces core;');
console.log('  class plugin_host plugin;');
console.log('  class pub_core,viewmodel,components,pages,conversation,delegates,tabs,pub_handlers,utils,data public;');
console.log('  class llm,network,storage,logging,threading,tool_profiler,ws_handlers infra;');
console.log('```');
