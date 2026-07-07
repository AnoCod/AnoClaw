import { WindowManager } from './WindowManager.js';
import * as path from 'path';
import type { App, Tray as TrayInst, Menu as MenuType } from 'electron';
import type { nativeImage as NativeImageAPI } from 'electron';

export class TrayManager {
  private static instance: TrayManager;
  private tray: TrayInst | null = null;
  private _Tray: typeof TrayInst;
  private _Menu: typeof MenuType;
  private _app: App;
  private _nativeImage: typeof NativeImageAPI;

  private constructor(Tray: typeof TrayInst, Menu: typeof MenuType, app: App, nativeImage: typeof NativeImageAPI) {
    this._Tray = Tray; this._Menu = Menu; this._app = app; this._nativeImage = nativeImage;
  }

  static getInstance(): TrayManager {
    if (!TrayManager.instance) TrayManager.instance = new TrayManager(null!, null!, null!, null!);
    return TrayManager.instance;
  }

  static init(Tray: typeof TrayInst, Menu: typeof MenuType, app: App, nativeImage: typeof NativeImageAPI): void {
    TrayManager.instance = new TrayManager(Tray, Menu, app, nativeImage);
  }

  createTray(): void {
    if (this.tray) return; // guard against duplicate creation
    const icon = this._nativeImage.createFromPath(path.join(this._app.getAppPath(), 'build', 'icon.ico'));
    this.tray = new this._Tray(icon.resize({ width: 16, height: 16 }));
    this.tray.setToolTip('AnoClaw');
    this.tray.setContextMenu(this._Menu.buildFromTemplate([
      { label: '打开 AnoClaw', click: () => this._showMain() },
      { label: '新建会话窗口', click: () => WindowManager.getInstance().createWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { globalThis._quitting = true; this._app.quit(); } },
    ]));
    this.tray.on('click', () => this._showMain());
  }

  private _showMain(): void {
    const win = WindowManager.getInstance().getMainWindow();
    if (win) { win.show(); win.focus(); }
    else WindowManager.getInstance().createWindow();
  }
}
