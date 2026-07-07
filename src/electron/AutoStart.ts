import type { App } from 'electron';

export function getAutoStart(app: App): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

export function setAutoStart(app: App, enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // Silently ignore — autostart is a convenience feature
  }
}
