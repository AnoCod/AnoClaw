/* CJS bridge — first code that runs. */
const m = require('electron');
if (typeof m === 'string') {
  const { spawn } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  // Dev mode: __dirname/../../ is the project root (real filesystem).
  // Packaged (asar): __dirname is virtual inside app.asar — use real path.
  const devDir = path.resolve(__dirname, '../..');
  const pkgDir = path.resolve(process.execPath, '..', 'resources', 'app.asar');
  const appDir = fs.existsSync(pkgDir) ? pkgDir : devDir;
  const child = spawn(m, [appDir], { stdio: 'inherit', env });
  child.on('close', (c) => process.exit(c ?? 0));
  return;
}

// Rendering switches - before app.whenReady.
// Auto mode prefers Chromium hardware acceleration (dGPU/iGPU) and keeps
// software fallback enabled for GPU-less or blocked-driver machines.
const gpuMode = String(process.env.ANOCLAW_GPU_MODE || 'auto').toLowerCase();
if (gpuMode === 'cpu' || gpuMode === 'software' || gpuMode === 'off') {
  m.app.disableHardwareAcceleration();
} else {
  m.app.commandLine.appendSwitch('enable-gpu-rasterization');
  m.app.commandLine.appendSwitch('enable-zero-copy');
  if (process.platform === 'win32') {
    m.app.commandLine.appendSwitch('use-angle', 'd3d11');
  }
  if (gpuMode === 'force') {
    m.app.commandLine.appendSwitch('ignore-gpu-blocklist');
  }
}
// Enable CDP debugging port for playwright-core Agent browser automation
const cdpPort = process.env.ANOCLAW_CDP_PORT || '9222';
m.app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
m.app.commandLine.appendSwitch('remote-allow-origins', `http://localhost:${cdpPort}`);

if (!m.app.requestSingleInstanceLock()) process.exit(0);
m.app.on('second-instance', () => {
  // Focus existing window when user tries to launch again
  try {
    const w = require('./WindowManager.js').WindowManager.getInstance().getMainWindow();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  } catch (err) {
    console.error('second-instance: failed to focus existing window', err);
  }
});

(async () => {
  const { createApp } = await import('./main.js');
  createApp(m);
})();
