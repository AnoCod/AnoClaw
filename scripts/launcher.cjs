// AnoClaw Server Launcher — spawns server as child process.
// Close this window → server stops. Double-click to start, re-run to restart.

import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 3456;

// ── Kill existing server ──
try {
  const out = execSync(`netstat -ano | findstr ":${PORT}.*LISTENING"`, { encoding: 'utf8', shell: 'cmd.exe' });
  const match = out.match(/(\d+)\s*$/m);
  if (match) {
    process.stdout.write(`Stopping existing server (PID ${match[1]})... `);
    execSync(`taskkill /F /PID ${match[1]}`, { shell: 'cmd.exe' });
    console.log('stopped.');
  }
} catch { /* no existing server */ }

// ── Build then start ──
console.log('Building...');
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe', shell: 'cmd.exe' });
} catch {
  console.error('Build failed. Starting anyway with existing dist/...');
}

console.log('Starting AnoClaw...');
const child = spawn('node', ['dist/server/main.js'], {
  cwd: ROOT, stdio: 'inherit', shell: 'cmd.exe',
});

child.on('error', (err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

console.log(`\n  Server: http://localhost:${PORT}`);
console.log('  Press Ctrl+C or close this window to stop.\n');

// ── Shutdown hook ──
function cleanup() {
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
  console.log(`Server exited (code ${code}).`);
  process.exit(code ?? 0);
});
