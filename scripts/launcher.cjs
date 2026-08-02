// AnoClaw Server Launcher — spawns server as child process.
// Close this window → server stops. Double-click to start, re-run to restart.

const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(ROOT, 'dist', 'server', 'main.js');
const PID_FILE = join(ROOT, 'data', '.launcher-process.json');

// ── Stop only a server previously started by this launcher ──
try {
  const record = JSON.parse(readFileSync(PID_FILE, 'utf8'));
  const pid = Number(record?.pid);
  if (Number.isInteger(pid) && pid > 0 && record?.root === ROOT) {
    const query = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    const commandLine = execFileSync('pwsh', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).trim();
    const expectedEntry = SERVER_ENTRY.toLowerCase();
    if (commandLine.toLowerCase().includes(expectedEntry)) {
      process.stdout.write(`Stopping launcher-owned server (PID ${pid})... `);
      process.kill(pid, 'SIGTERM');
      console.log('stopped.');
    } else {
      console.warn(`Ignoring stale launcher PID ${pid}; its command line is not AnoClaw.`);
    }
  }
} catch { /* no live launcher-owned server */ }
try { rmSync(PID_FILE, { force: true }); } catch {}

// ── Build then start ──
console.log('Building...');
try {
  execFileSync('npm.cmd', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
} catch {
  console.error('Build failed. Starting anyway with existing dist/...');
}

console.log('Starting AnoClaw...');
const child = spawn('node', [SERVER_ENTRY], {
  cwd: ROOT, stdio: 'inherit', shell: false,
});
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, root: ROOT }, null, 2), 'utf8');

child.on('error', (err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

console.log(`\n  Server: http://localhost:${PORT}`);
console.log('  Press Ctrl+C or close this window to stop.\n');

// ── Shutdown hook ──
function cleanup() {
  try {
    if (existsSync(PID_FILE)) {
      const record = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      if (record?.pid === child.pid) rmSync(PID_FILE, { force: true });
    }
  } catch {}
  if (child.exitCode === null) {
    console.log('\nStopping server...');
    child.kill('SIGTERM');
    // Force kill after 3 seconds
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
  }
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => { if (child.exitCode === null) child.kill(); });

// Keep alive on Windows
if (process.platform === 'win32') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.emit('SIGINT', 'SIGINT'));
}

child.on('exit', (code) => {
  cleanup();
  console.log(`Server exited (code ${code}).`);
  process.exit(code ?? 0);
});
