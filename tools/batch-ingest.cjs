// Batch ingest reference source files into RAG vector DB.
// Run: node tools/batch-ingest.js
// Prerequisite: MCP server NOT running (only one LanceDB writer at a time).

const path = require("path");
const fs = require("fs");
const { RAGServer } = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/@yikizi/mcp-local-rag/dist/server/index.js");

const REF_DIR = "F:/QoderSoft/reference";
const GLOBAL_NODE_MODULES = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@yikizi/mcp-local-rag";

const config = {
  dbPath: "F:/QoderSoft/AnoClaw/lancedb",
  modelName: "Xenova/all-MiniLM-L6-v2",
  cacheDir: path.join(GLOBAL_NODE_MODULES, "models"),
  baseDir: REF_DIR,
  maxFileSize: 100 * 1024 * 1024, // 100MB
  chunkSize: 512,
  chunkOverlap: 100,
};

// Extensions to index
const EXTS = new Set([".py", ".ts", ".tsx", ".rs", ".md", ".txt", ".js"]);

// Per-project core source roots (skip CLI, docs, tests, deploy scripts, etc.)
const PROJECT_ROOTS = {
  "crewAI": ["lib/crewai/src/crewai"],
  "danya": ["src"],
  "hermes-agent": ["agent", "acp_adapter"],
  "autogen": [
    "python/packages/autogen-core/src/autogen_core",
    "python/packages/autogen-agentchat/src/autogen_agentchat",
  ],
  "comfyui-backend": ["comfy", "comfy_execution", "comfy_api", "comfy_api_nodes", "app"],
  "comfyui-frontend": [],  // React frontend, skip for now
  "codex": [
    "codex-rs/agent-graph-store",
    "codex-rs/agent-identity",
    "codex-rs/chatgpt",
    "codex-rs/codex-mcp",
    "codex-rs/context-fragments",
    "codex-rs/core-api",
    "codex-rs/prompts",
    "codex-rs/tools",
    "codex-rs/external-agent-sessions",
    "codex-rs/apply-patch",
  ],
  "headroom": [],
  "Claude code 源码": ["claude-code-analysis-main/analysis"],
};

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_FILE_SIZE = 2 * 1024 * 1024; // skip files > 2MB
const LARGE_FILE_THRESHOLD = 50 * 1024; // 50KB+ gets extra delay

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", "dist", "target", "build", "out",
  "tests", "test", "__tests__", "__test__", "spec", "specs",
  ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
  "eggs", ".eggs", "coverage", "htmlcov",
]);

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listFiles(dir, exts, excludeDirs) {
  const results = [];
  function walk(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".danya") continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (excludeDirs.has(e.name)) continue;
          walk(full);
        } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
          results.push(full);
        }
      }
    } catch (_) {
      // permission denied, skip
    }
  }
  walk(dir);
  return results;
}

async function main() {
  console.error("=== RAG Batch Ingest ===\n");

  const server = new RAGServer(config);
  await server.initialize();

  // Get already-indexed files
  let existing = [];
  try {
    existing = await server.vectorStore.listFiles();
  } catch (e) {
    console.error("Warning: couldn't list existing files:", e.message);
  }
  const existingSet = new Set(existing.map((f) => f.filePath));
  console.error(`Already indexed: ${existingSet.size} files\n`);

  // Collect all source files
  let allFiles = [];
  for (const [project, roots] of Object.entries(PROJECT_ROOTS)) {
    const projDir = path.join(REF_DIR, project);
    if (!fs.existsSync(projDir)) {
      console.error(`SKIP (missing): ${projDir}`);
      continue;
    }
    if (roots.length === 0) {
      console.error(`SKIP (empty roots): ${project}`);
      continue;
    }
    for (const root of roots) {
      const rootDir = path.join(projDir, root);
      if (!fs.existsSync(rootDir)) {
        console.error(`SKIP (missing): ${rootDir}`);
        continue;
      }
      const files = listFiles(rootDir, EXTS, EXCLUDE_DIRS);
      console.error(`Found ${files.length} source files in ${project}/${root}/`);
      allFiles.push(...files);
    }
  }

  // Filter out already-indexed
  const toIndex = allFiles.filter((f) => !existingSet.has(f));
  console.error(`\nTo index: ${toIndex.length} files\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < toIndex.length; i++) {
    const fp = toIndex[i].replace(/\\/g, "/");
    const fileName = path.basename(fp);
    const project = fp.slice((REF_DIR + "/").length).split("/")[0];
    let fileSize = 0;
    try { fileSize = fs.statSync(toIndex[i]).size; } catch (_) {}

    if (fileSize > MAX_FILE_SIZE) {
      console.error(`[${i + 1}/${toIndex.length}] SKIP (too large: ${fileSize} bytes): ${path.relative(REF_DIR, fp)}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.error(`[${i + 1}/${toIndex.length}] WOULD INDEX: ${path.relative(REF_DIR, fp)} (${fileSize} bytes)`);
      ok++;
      continue;
    }

    console.error(`[${i + 1}/${toIndex.length}] ${path.relative(REF_DIR, fp)} (${fileSize} bytes)`);

    try {
      const result = await server.handleIngestFile({
        filePath: fp,
        tags: [project],
        project: project,
      });
      console.error(`  -> ${result.chunkCount} chunks`);
      ok++;

      // Delay: small 300ms, large 2s, giant (>200KB) 5s
      if (fileSize > 200 * 1024) await delay(5000);
      else if (fileSize > LARGE_FILE_THRESHOLD) await delay(2000);
      else await delay(300);
    } catch (e) {
      console.error(`  -> FAILED: ${e.message}`);
      failed++;
      await delay(1000);
    }
  }

  console.error(`\n=== Done: ${ok} ok, ${skipped} skipped, ${failed} failed ===`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
