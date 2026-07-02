export function getAutoStart(app: any): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutoStart(app: any, enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}
