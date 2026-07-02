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

// GPU switches — before app.whenReady
m.app.commandLine.appendSwitch('disable-gpu-vsync');
m.app.commandLine.appendSwitch('enable-gpu-rasterization');
m.app.commandLine.appendSwitch('use-angle', 'direct-composition');
// Prevent Chrome from throttling renderer during resize
m.app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
m.app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Enable CDP debugging port for playwright-core Agent browser automation
m.app.commandLine.appendSwitch('remote-debugging-port', '9222');
m.app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222');

if (!m.app.requestSingleInstanceLock()) process.exit(0);
m.app.on('second-instance', () => {
  // Focus existing window when user tries to launch again
  try {
    const w = require('./WindowManager.js').WindowManager.getInstance().getMainWindow();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  } catch {}
});

(async () => {
  const { createApp } = await import('./main.js');
  createApp(m);
})();
