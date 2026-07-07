// AnoClaw API E2E Test Suite
// Run: node tools/api-test.cjs [--base=http://127.0.0.1:3456]
const http = require("http");
const BASE = process.argv.find(a => a.startsWith("--base="))?.split("=")[1] || "http://127.0.0.1:3456";
const VERBOSE = process.argv.includes("--verbose");

let pass = 0, fail = 0;
const failures = [];

function request(method, path, body, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: { "Content-Type": body ? "application/json" : undefined, "X-API-Key": opts?.apiKey || "dev" },
      timeout: opts?.timeout || 30000 };
    Object.keys(options.headers).forEach(k => options.headers[k] === undefined && delete options.headers[k]);
    const req = http.request(options, res => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${method} ${path}`)); });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ok(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`❌ ${name}` + (detail ? " — " + detail : "")); console.error(`  ❌ ${name}` + (detail ? " — " + detail : "")); }
  return cond;
}
function http200(name, res) { return ok(`${name} (HTTP ${res.status})`, res.status >= 200 && res.status < 400, JSON.stringify(res.body)?.slice(0, 150)); }

// Helper: unwrap common response wrappers
function arr(body, key) { return body?.[key] || (Array.isArray(body) ? body : []); }
function obj(body, key) { return body?.[key] || body; }

let sessionId, memoryId, agentId;

async function main() {
  console.error("\n=== AnoClaw API E2E Test ===");
  console.error("Base:", BASE, "\n");

  // ── System ──
  console.error("── System ──");
  let r;
  r = await request("GET", "/api/v1/health"); http200("GET /health", r); ok("health.version", r.body?.version);
  r = await request("GET", "/api/v1/system/info"); http200("GET /system/info", r); ok("uptime", typeof r.body?.uptime === "number");
  r = await request("GET", "/api/v1/endpoints"); http200("GET /endpoints", r);
  r = await request("GET", "/api/v1/stats"); http200("GET /stats", r);

  // ── Agents ──
  console.error("── Agents ──");
  r = await request("GET", "/api/v1/agents");
  const agents = arr(r.body, "agents");
  http200("GET /agents", r); ok("agents array", Array.isArray(agents)); ok("≥1 agent", agents.length >= 1);
  agentId = agents[0]?.id || "ceo";

  if (agentId) {
    r = await request("GET", `/api/v1/agents/${agentId}`); http200("GET /agents/:id", r); ok("has role", r.body?.role);
    r = await request("GET", `/api/v1/agents/${agentId}/status`); http200("GET status", r);
    r = await request("GET", "/api/v1/agents/org-tree"); http200("GET org-tree", r);
    r = await request("GET", `/api/v1/agents/${agentId}/report-chain`); http200("GET report-chain", r);
    r = await request("GET", "/api/v1/agents-find?q=ceo"); http200("GET find", r);
  }

  // ── Sessions ──
  console.error("── Sessions ──");
  r = await request("POST", "/api/v1/sessions", { agentId: "ceo", title: "API Test" });
  ok("POST /sessions", r.status === 200 || r.status === 201);
  sessionId = r.body?.sessionId || r.body?.id;
  ok("sessionId returned", !!sessionId, sessionId);

  r = await request("GET", "/api/v1/sessions"); http200("GET list", r);
  const sessions = arr(r.body, "sessions"); ok("sessions non-empty", Array.isArray(sessions) && sessions.length >= 1);
  r = await request("GET", "/api/v1/sessions/tree"); http200("GET tree", r);

  if (sessionId) {
    r = await request("GET", `/api/v1/sessions/${sessionId}`); http200("GET /:id", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/workspace`); http200("GET workspace", r); ok("workspace path", r.body?.workspace);
    r = await request("PATCH", `/api/v1/sessions/${sessionId}/bind-workspace`, { path: process.cwd().replace(/\\/g, "/") }); http200("PATCH bind", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/overview`); http200("GET overview", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/messages`); http200("GET messages", r); ok("messages array", Array.isArray(r.body?.messages));
    r = await request("GET", `/api/v1/sessions/${sessionId}/parent`); ok("GET parent", r.status === 200 || r.status === 404); // root sessions have no parent
    r = await request("GET", `/api/v1/sessions/${sessionId}/root`); http200("GET root", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/background-tasks`); http200("GET bg-tasks", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/tool-stats`); http200("GET tool-stats", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/interrupt-status`); http200("GET int-status", r);
    r = await request("PATCH", `/api/v1/sessions/${sessionId}`, { title: "Renamed" }); http200("PATCH rename", r);
    r = await request("PATCH", `/api/v1/sessions/${sessionId}/metadata`, { key: "test", value: "ok" }); http200("PATCH metadata", r);
    r = await request("GET", `/api/v1/sessions/${sessionId}/tree`); http200("GET subtree", r);
  }

  // ── Message send (triggers Agent) ──
  console.error("── Message ──");
  if (sessionId) {
    r = await request("POST", `/api/v1/sessions/${sessionId}/messages`, { content: "Say 'OK' only — API test.", mode: "ask" }, { timeout: 60000 });
    ok("POST /messages", r.status === 200 || r.status === 202 || r.status === 400, `HTTP ${r.status}: ${JSON.stringify(r.body)?.slice(0, 100)}`);
  }

  // ── Tools ──
  console.error("── Tools ──");
  r = await request("GET", "/api/v1/tools");
  const allTools = arr(r.body, "tools");
  http200("GET tools", r); ok("tools arr", Array.isArray(allTools));
  r = await request("GET", "/api/v1/tools/groups"); http200("GET groups", r);
  r = await request("GET", "/api/v1/commands"); http200("GET commands", r);
  r = await request("GET", "/api/v1/tools/stats"); http200("GET stats", r);
  const firstToolName = allTools[0]?.name;
  if (firstToolName) {
    r = await request("GET", `/api/v1/tools/${firstToolName}`); http200("GET /tools/:name", r);
  }
  if (agentId) {
    r = await request("GET", `/api/v1/tools-for-agent/${agentId}`);
    const at = arr(r.body, "tools"); ok("tools-for-agent", Array.isArray(at));
  }

  // ── Memory ──
  console.error("── Memory ──");
  r = await request("POST", "/api/v1/memory", { type: "memory", scope: "personal", name: "test-mem", content: "API test memory.", agentId: "ceo" });
  ok("POST memory", r.status === 200 || r.status === 201);
  memoryId = r.body?.id || r.body?.entry?.id;
  r = await request("GET", "/api/v1/memory"); http200("GET list", r);
  r = await request("GET", "/api/v1/memory/search?q=test&limit=5"); http200("GET search", r);

  // ── Workspace ──
  console.error("── Workspace ──");
  r = await request("GET", `/api/v1/workspace/browse?path=${encodeURIComponent(process.cwd().replace(/\\/g, "/"))}`);
  http200("GET browse", r); ok("browse data", r.body && Array.isArray(r.body.nodes));

  // ── Plugins ──
  console.error("── Plugins ──");
  r = await request("GET", "/api/v1/plugins"); http200("GET list", r);
  r = await request("GET", "/api/v1/plugins/status"); http200("GET status", r);
  r = await request("GET", "/api/v1/plugins/extensions"); http200("GET extensions", r);

  // ── Skills ──
  console.error("── Skills ──");
  r = await request("GET", "/api/v1/skills"); http200("GET list", r);

  // ── Search ──
  console.error("── Search ──");
  r = await request("GET", "/api/v1/search?q=test"); http200("GET search", r);

  // ── Settings ──
  console.error("── Settings ──");
  r = await request("GET", "/api/v1/settings/ui"); http200("GET /settings/ui", r);

  // ── WS ──
  console.error("── WS ──");
  r = await request("GET", "/api/v1/ws/connections"); http200("GET connections", r);

  // ── Prompt ──
  console.error("── Prompt ──");
  r = await request("GET", "/api/v1/prompt/sections"); http200("GET sections", r);
  if (agentId) {
    r = await request("GET", `/api/v1/agents/${agentId}/prompt?sessionId=${sessionId || "test"}`);
    http200("GET prompt", r);
  }

  // ── Cleanup ──
  console.error("── Cleanup ──");
  if (memoryId) { r = await request("DELETE", `/api/v1/memory/${memoryId}`); http200("DELETE memory", r); }
  if (sessionId) {
    await new Promise(r => setTimeout(r, 2000));
    r = await request("DELETE", `/api/v1/sessions/${sessionId}`); http200("DELETE session", r);
  }

  // ── Report ──
  const total = pass + fail;
  console.error(`\n=== Results: ${pass}/${total} passed${fail > 0 ? `, ${fail} failed` : ""} ===\n`);
  if (failures.length) { console.error("Failures:"); failures.forEach(f => console.error(" ", f)); }
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(err => { console.error(`\n❌ FATAL: ${err.message}`); process.exit(1); });
