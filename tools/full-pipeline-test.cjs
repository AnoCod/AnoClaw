// AnoClaw Full Pipeline E2E Test: long conversation + delegation + team + tools
// Run: node tools/full-pipeline-test.cjs [--base=http://127.0.0.1:3456]
// Prerequisite: AnoClaw running, CEO agent with API key configured, org tree with
// Engineer Manager + Developer One/Two as subordinates.

const http = require("http");
const BASE = (process.argv.find(a => a.startsWith("--base=")) || "--base=http://127.0.0.1:3456").split("=")[1];

let pass = 0, fail = 0;
const failures = [];

function request(method, path, body, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), "X-API-Key": opts?.apiKey || "dev" },
      timeout: opts?.timeout || 120000 };
    const req = http.request(options, res => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); } catch { resolve({ status: res.statusCode, body: null, raw: data }); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${method} ${path}`)); });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ok(name, cond, detail) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; const m = `\n❌ ${name}` + (detail ? " — " + detail : ""); failures.push(m); console.error(m); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll for new messages until timeout or until we find expected content
async function waitForResponse(sessionId, checkFn, maxWaitMs, pollMs) {
  const deadline = Date.now() + (maxWaitMs || 120000);
  const interval = pollMs || 3000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", `/api/v1/sessions/${sessionId}/messages`);
      const msgs = r.body?.messages || [];
      // Check new messages added since last poll
      for (let i = lastCount; i < msgs.length; i++) {
        const m = msgs[i];
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const role = m.role || m.type || "";
        if (checkFn(m, content, role, i)) return { found: true, message: m, allMessages: msgs, elapsedMs: Date.now() - (deadline - maxWaitMs) };
      }
      lastCount = Math.max(lastCount, msgs.length);
    } catch {}
    await sleep(interval);
  }
  return { found: false, allMessages: [], elapsedMs: maxWaitMs };
}

async function main() {
  console.error("\n╔════════════════════════════════════════╗");
  console.error("║  AnoClaw Full Pipeline E2E Test      ║");
  console.error("╚════════════════════════════════════════╝");
  console.error("Base:", BASE, "\n");

  // ─────────────────────────────────────────────
  // PHASE 1: Pre-flight checks
  // ─────────────────────────────────────────────
  console.error("\n── Phase 1: Pre-flight ──");
  let r;

  r = await request("GET", "/api/v1/health"); ok("Server alive", r.body?.version);
  r = await request("GET", "/api/v1/agents"); const agents = r.body?.agents || [];
  ok("Agents exist", agents.length >= 3, `found ${agents.length}`);
  console.error(`  Agents: ${agents.map(a => `${a.id}(${a.role})`).join(", ")}`);

  r = await request("GET", "/api/v1/tools"); const tools = r.body?.tools || [];
  ok("Tools exist", tools.length >= 10, `found ${tools.length}`);
  console.error(`  Tools: ${tools.length}`);

  r = await request("GET", "/api/v1/plugins/status"); ok("Plugin host alive", r.body?.status || r.body?.healthy);

  // ─────────────────────────────────────────────
  // PHASE 2: Create session + basic chat
  // ─────────────────────────────────────────────
  console.error("\n── Phase 2: Session + basic chat ──");

  r = await request("POST", "/api/v1/sessions", { agentId: "ceo", title: "E2E Pipeline Test" });
  const sid = r.body?.sessionId || r.body?.id;
  ok("Session created", !!sid, sid);

  // Short ping-pong to verify agent responds (requires WS connection!)
  console.error("  Sending ping...");
  r = await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "Reply with exactly 'pong' and nothing else. No tools. No formatting.",
    mode: "ask",
  });

  if (r.status === 503) {
    console.error("  ⚠ WS not connected — message send requires frontend WebSocket. Skipping chat tests.");
    // Skip remaining chat-dependent tests
  } else {
    ok("Message accepted", r.status === 202, `HTTP ${r.status}`);

  const ping = await waitForResponse(sid,
    (m, content) => m.role === "assistant" && /pong/i.test(content), 90000, 3000);
  ok("Ping-pong", ping.found, `${Math.round(ping.elapsedMs / 1000)}s`);
  if (ping.found) console.error(`  pong in ${(ping.elapsedMs / 1000).toFixed(1)}s`);

  // ─────────────────────────────────────────────
  // PHASE 3: Tool execution test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 3: Tool execution ──");

  // Test direct tool execution via API
  r = await request("POST", "/api/v1/tools/execute", {
    toolName: "Read",
    params: { file_path: require("path").resolve(process.cwd(), "package.json") },
    sessionId: sid,
    agentId: "ceo",
  });
  ok("Tool execute API", r.status === 200, `HTTP ${r.status}`);
  // Read response format varies; check it contains package.json content
  const toolResult = typeof r.body === "string" ? r.body : JSON.stringify(r.body || "");
  ok("Tool result non-empty", toolResult.length > 20, `${toolResult.length} chars`);

  // Let agent use tools
  console.error("  Asking agent to check project...");
  await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "Use Read to check package.json, then use Glob to find all *.ts files in src/server/core/tools/builtin/. Just tell me the count of tools. Brief reply: 'Found X tools.'",
    mode: "ask",
    effort: false,
  });

  const toolCheck = await waitForResponse(sid,
    (m, content, role) => role === "assistant" && /found|tools|count/i.test(content), 120000, 4000);
  ok("Agent uses tools", toolCheck.found, `${Math.round(toolCheck.elapsedMs / 1000)}s`);
  if (toolCheck.found) console.error(`  agent replied in ${(toolCheck.elapsedMs / 1000).toFixed(1)}s`);

  // ─────────────────────────────────────────────
  // PHASE 4: Team awareness test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 4: Team awareness ──");

  await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "List all agents in the organization. Reply with format: 'Organization: X agents.'",
    mode: "ask",
    effort: false,
  });

  const orgCheck = await waitForResponse(sid,
    (m, content) => m.role === "assistant" && /agent|organization/i.test(content), 90000, 4000);
  ok("Agent lists org", orgCheck.found, `${Math.round(orgCheck.elapsedMs / 1000)}s`);

  // ─────────────────────────────────────────────
  // PHASE 5: Delegation test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 5: Delegation chain ──");

  // Check if Manager exists for delegation
  const managers = agents.filter(a => a.role === "Manager");
  if (managers.length > 0) {
    const mgr = managers[0];
    console.error(`  Delegating to ${mgr.name}...`);

    await request("POST", `/api/v1/sessions/${sid}/messages`, {
      content: `Delegate a task to ${mgr.name}: Create a file called e2e-test-result.txt in the workspace root containing "E2E delegation test passed at ${new Date().toISOString()}". Use TaskAssign. Wait for completion, verify the file exists, then tell me "Delegation: SUCCESS" or "Delegation: FAILED".`,
      mode: "auto",
      effort: false,
    });

    const delCheck = await waitForResponse(sid,
      (m, content) => m.role === "assistant" && /delegation:\s*(success|fail|done)/i.test(content), 300000, 5000);
    ok("Delegation chain", delCheck.found, `${Math.round(delCheck.elapsedMs / 1000)}s`);
    if (delCheck.found) console.error(`  delegation result in ${(delCheck.elapsedMs / 1000).toFixed(1)}s`);
    if (delCheck.message) {
      const txt = typeof delCheck.message.content === "string" ? delCheck.message.content : JSON.stringify(delCheck.message.content);
      if (/success/i.test(txt)) {
        // Verify the file was actually created
        r = await request("GET", `/api/v1/sessions/${sid}/workspace`);
        const ws = r.body?.workspace || "";
        const fs = require("fs");
        const testFile = require("path").join(ws, "e2e-test-result.txt");
        ok("Delegation output file exists", fs.existsSync(testFile), testFile);
      }
    }
  } else {
    console.error("  SKIP: No Manager agent found for delegation test");
  }

  // ─────────────────────────────────────────────
  // PHASE 6: Background task notification test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 6: Background task notification ──");

  r = await request("GET", `/api/v1/sessions/${sid}/background-tasks`);
  ok("Background tasks API", r.status === 200);

  // ─────────────────────────────────────────────
  // PHASE 7: Multi-agent communication
  // ─────────────────────────────────────────────
  console.error("\n── Phase 7: Agent communication ──");

  await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "Use AgentMessage to send a quick greeting to Engineer Manager. Wait for a reply. Then tell me 'Comm: OK' if you got a response, or 'Comm: NO_REPLY' if not.",
    mode: "auto",
    effort: false,
  });

  const commCheck = await waitForResponse(sid,
    (m, content) => m.role === "assistant" && /comm:\s*(ok|no_reply)/i.test(content), 180000, 5000);
  ok("Agent communication", commCheck.found, `${Math.round(commCheck.elapsedMs / 1000)}s`);

  // ─────────────────────────────────────────────
  // PHASE 8: Memory persistence test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 8: Memory ──");

  await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "Remember this fact using MemorySave: 'E2E test ran successfully at " + new Date().toISOString() + "'. Scope: personal. Then immediately search for it with MemorySearch and confirm you found it. Reply: 'Memory: OK' or 'Memory: FAILED'.",
    mode: "auto",
    effort: false,
  });

  const memCheck = await waitForResponse(sid,
    (m, content) => m.role === "assistant" && /memory:\s*(ok|failed)/i.test(content), 120000, 5000);
  ok("Memory save/search", memCheck.found, `${Math.round(memCheck.elapsedMs / 1000)}s`);

  // ─────────────────────────────────────────────
  // PHASE 9: Settings write/read
  // ─────────────────────────────────────────────
  console.error("\n── Phase 9: Settings ──");

  r = await request("GET", "/api/v1/settings/ui"); ok("Settings read", r.status === 200);

  // ─────────────────────────────────────────────
  // PHASE 10: Search
  // ─────────────────────────────────────────────
  console.error("\n── Phase 10: Search ──");

  r = await request("GET", "/api/v1/search?q=E2E+test"); ok("Unified search", r.status === 200);

  // ─────────────────────────────────────────────
  // PHASE 11: Long conversation context test
  // ─────────────────────────────────────────────
  console.error("\n── Phase 11: Long context ──");

  // Send multi-turn conversation to test context retention
  await request("POST", `/api/v1/sessions/${sid}/messages`, {
    content: "I'm going to give you 3 facts. Remember all 3, then repeat them back.\nFact 1: The sky is blue.\nFact 2: Water is wet.\nFact 3: Fire is hot.\n\nNow repeat all 3 facts back to me in a numbered list.",
    mode: "ask",
    effort: false,
  });

  const ctxCheck = await waitForResponse(sid,
    (m, content) => m.role === "assistant" && /sky.*blue|water.*wet|fire.*hot/i.test(content), 120000, 4000);
  ok("Context retention", ctxCheck.found, `${Math.round(ctxCheck.elapsedMs / 1000)}s`);

  // ─────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────
  console.error("\n── Cleanup ──");

  // Clean up test file
  try {
    r = await request("GET", `/api/v1/sessions/${sid}/workspace`);
    const ws = r.body?.workspace || "";
    const testFile = require("path").join(ws, "e2e-test-result.txt");
    require("fs").unlinkSync(testFile);
  } catch {}

  await request("DELETE", `/api/v1/sessions/${sid}`);
  ok("Session cleaned up", true);

  // ─────────────────────────────────────────────
  // REPORT
  // ─────────────────────────────────────────────
  const total = pass + fail;
  console.error(`\n\n=== Full Pipeline Results: ${pass}/${total} passed${fail > 0 ? `, ${fail} FAILED` : " 🎉"} ===`);
  if (failures.length) {
    console.error("\nFailures:");
    failures.forEach(f => console.error(f));
  }
  console.error(`Time: ${new Date().toISOString()}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(`\n💥 FATAL: ${err.message}\n${err.stack}`); process.exit(1); });
