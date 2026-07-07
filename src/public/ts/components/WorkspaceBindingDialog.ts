// AnoClaw Frontend — Workspace Binding Dialog
// Folder picker for binding (or switching) a workspace directory for a session.
// Browse uses Electron's native dialog.showOpenDialog for full paths.

/** Normalize a user-entered path: d:G22 → D:\G22, forward slashes → backslashes. */
function normalizePath(raw: string): string {
  let p = raw.trim();
  if (!p) return p;
  const bareDrive = p.match(/^([a-zA-Z]):([^\\\/].*)$/);
  if (bareDrive) p = `${bareDrive[1].toUpperCase()}:\\${bareDrive[2]}`;
  const fwdDrive = p.match(/^([a-zA-Z]):\/(.*)$/);
  if (fwdDrive) p = `${fwdDrive[1].toUpperCase()}:\\${fwdDrive[2]}`;
  p = p.replace(/^([a-zA-Z]):/, (_: string, d: string) => d.toUpperCase() + ':');
  return p;
}

export interface WorkspaceBindingResult {
  path: string;
}

export class WorkspaceBindingDialog {
  private _overlay: HTMLElement;
  private _dialog: HTMLElement;
  private _resolve: ((value: WorkspaceBindingResult | null) => void) | null = null;

  constructor() {
    this._overlay = document.createElement('div');
    this._overlay.className = 'dialog-overlay';
    this._overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center; z-index: 1000;
    `;
    this._dialog = document.createElement('div');
    this._dialog.className = 'dialog';
    this._dialog.style.cssText = `
      background: var(--color-surface); border: 1px solid var(--color-hairline);
      border-radius: 10px; padding: 24px; width: 460px; box-shadow: none;
    `;
    this._overlay.appendChild(this._dialog);
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this._cancel();
    });
  }

  show(currentPath?: string): Promise<WorkspaceBindingResult | null> {
    console.log('[Workspace] show currentPath:', currentPath);
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._build(currentPath);
      document.body.appendChild(this._overlay);
    });
  }

  private _build(currentPath?: string): void {
    const isSwitch = !!currentPath;
    const primary = 'var(--color-primary, #ffffff)';
    const onPrimary = 'var(--color-on-primary, #000000)';
    const text = 'var(--color-text-primary)';
    const textSec = 'var(--color-text-secondary)';
    const bg = 'var(--color-surface-elevated)';
    const border = 'var(--color-hairline)';

    this._dialog.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-size:18px;font-weight:600;color:${text};margin:0;">${isSwitch ? 'Switch Workspace' : 'Bind Workspace'}</h2>
        <button class="dialog-close" style="background:none;border:none;color:${textSec};cursor:pointer;font-size:20px;line-height:1;">&times;</button>
      </div>
      <form id="workspace-dialog-form" style="display:flex;flex-direction:column;gap:12px;">
        ${isSwitch ? `
        <div style="font-size:11px;color:${textSec};margin-bottom:-4px;">
          Current: <span style="color:${text};font-family:var(--font-mono,monospace);font-size:10px;">${esc(currentPath!)}</span>
        </div>` : ''}
        <div>
          <label style="font-size:12px;color:${textSec};display:block;margin-bottom:4px;">${isSwitch ? 'New Workspace Path' : 'Workspace Path'}</label>
          <div style="display:flex;gap:8px;">
            <input name="path" id="ws-path-input" value="${esc(currentPath || '')}" placeholder="D:\\projects or /home/user/project"
              style="flex:1;padding:8px 10px;background:${bg};border:1px solid ${border};border-radius:6px;color:${text};font-size:13px;">
            <button type="button" id="ws-browse-btn"
              style="padding:8px 14px;background:${bg};border:1px solid ${border};border-radius:6px;color:${text};cursor:pointer;font-size:13px;white-space:nowrap;">
              Browse…
            </button>
          </div>
        </div>
        <p style="font-size:11px;color:${textSec};margin:8px 0 0;">
          ${isSwitch
            ? 'Switching workspace will point the agent to a new directory.'
            : 'Bind a folder so the agent can read and write files within it.'}
        </p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
          <button type="button" id="ws-cancel-btn"
            style="padding:8px 20px;background:transparent;border:1px solid ${border};border-radius:6px;color:${text};cursor:pointer;font-size:13px;">
            Cancel</button>
          <button type="submit"
            style="padding:8px 20px;background:${primary};border:1px solid ${primary};border-radius:8px;color:${onPrimary};cursor:pointer;font-size:13px;font-weight:500;">
            ${isSwitch ? 'Switch' : 'Bind'}</button>
        </div>
      </form>
    `;

    const closeBtn = this._dialog.querySelector('.dialog-close') as HTMLButtonElement;
    if (closeBtn) closeBtn.addEventListener('click', () => this._cancel());
    const cancelBtn = this._dialog.querySelector('#ws-cancel-btn') as HTMLButtonElement;
    if (cancelBtn) cancelBtn.addEventListener('click', () => this._cancel());

    const pathInput = this._dialog.querySelector('#ws-path-input') as HTMLInputElement;
    const browseBtn = this._dialog.querySelector('#ws-browse-btn') as HTMLButtonElement;
    if (browseBtn && pathInput) {
      browseBtn.addEventListener('click', async () => {
        try {
          const api = (window as any).electronAPI;
          if (api?.showOpenDialog) {
            const pickResult = await api.showOpenDialog({
              properties: ['openDirectory'],
              title: isSwitch ? 'Select New Workspace Folder' : 'Select Workspace Folder',
            });
            if (!pickResult.canceled && pickResult.filePaths?.length > 0) {
              pathInput.value = normalizePath(pickResult.filePaths[0]);
              pathInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } else {
            // Electron API not available — type path manually
            pathInput.focus();
          }
        } catch (err) {
          // Dialog failed — let user type path manually
          pathInput.focus();
        }
      });
    }

    const form = this._dialog.querySelector('#workspace-dialog-form') as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(form);
      const rawPath = formData.get('path') as string;
      const result: WorkspaceBindingResult = {
        path: normalizePath(rawPath),
      };
      if (!result.path.trim()) {
        pathInput?.focus();
        return;
      }
      this._close(result);
    });
  }

  private _cancel(): void {
    console.log('[Workspace] cancel');
    this._close(null);
  }

  private _close(result: WorkspaceBindingResult | null): void {
    this._overlay.remove();
    if (this._resolve) {
      this._resolve(result);
      this._resolve = null;
    }
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
