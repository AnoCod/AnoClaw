// AnoClaw — ClickablePathHandler: central click delegation for file paths and external URLs
// Used by SessionsPage and SessionsPageOverfly to intercept clicks
// on .clickable-path spans and a[data-external-url] links.

import { ToastManager } from '../ToastManager.js';
import { resolveClickedFilePath } from './PathReferences.js';

interface ElectronAPI {
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openPath?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

function getAPI(): ElectronAPI | undefined {
  return (window as any).electronAPI as ElectronAPI | undefined;
}

/** Resolve a file path: absolute paths stay as-is, relative paths join to workspace. */
export function resolvePath(clickedPath: string, workspacePath: string): string | null {
  return resolveClickedFilePath(clickedPath, workspacePath);
}

/**
 * Handle a click event on a container that may contain .clickable-path spans
 * or external URL links. Call this from an event listener on the container.
 *
 * @param e          The click event
 * @param workspacePath  Current session's workspace root (empty string if none)
 */
export function handlePathClick(e: MouseEvent, workspacePath: string): void {
  let target = e.target as HTMLElement | null;
  if (!target) return;

  const api = getAPI();

  // Walk up to find .clickable-path or a[data-external-url]
  while (target) {
    // File path click
    if (target.classList?.contains('clickable-path')) {
      e.preventDefault();
      const rawPath = target.getAttribute('data-file-path');
      if (!rawPath) return;

      const resolved = resolvePath(rawPath, workspacePath);
      if (!resolved) {
        ToastManager.getInstance().info('No workspace bound. Open Workspace and bind a folder first.', 4000);
        return;
      }
      if (api?.openPath) {
        api.openPath(resolved).then((r) => {
          if (!r.ok && r.error) {
            ToastManager.getInstance().info('File not found: ' + resolved, 3000);
          }
        }).catch(() => {});
      } else {
        ToastManager.getInstance().info('File opening requires the desktop app.', 3000);
      }
      return;
    }

    // External URL click
    if (target.tagName === 'A' && target.getAttribute('data-external-url') !== null) {
      e.preventDefault();
      const href = (target as HTMLAnchorElement).href;
      if (!href) return;

      if (/^https?:\/\//i.test(href)) {
        if (api?.openExternal) {
          api.openExternal(href).catch(() => {});
        }
        // Fallback: if no API, let Electron's default behavior handle it
        // by opening in a new window. Don't show a toast — it's a URL,
        // the browser may handle it fine.
      }
      return;
    }

    target = target.parentElement;
  }
}
