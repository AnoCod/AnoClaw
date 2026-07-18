// AnoClaw — ClickablePathHandler: central click delegation for file paths and external URLs
// Used by SessionsPage and SessionsPageOverfly to intercept clicks
// on .clickable-path spans and a[data-external-url] links.

import { ToastManager } from '../ToastManager.js';
import {
  resolveClickedFilePath,
  resolveWorkspaceRelativePath,
} from './PathReferences.js';

interface ElectronAPI {
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openPath?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

function getAPI(): ElectronAPI | undefined {
  return (window as any).electronAPI as ElectronAPI | undefined;
}

let activeImagePreview: HTMLElement | null = null;
let activeImagePreviewKeyHandler: ((event: KeyboardEvent) => void) | null = null;

function closeImagePreview(): void {
  if (activeImagePreviewKeyHandler) {
    document.removeEventListener('keydown', activeImagePreviewKeyHandler);
    activeImagePreviewKeyHandler = null;
  }
  activeImagePreview?.remove();
  activeImagePreview = null;
}

function showImagePreview(src: string, alt: string): void {
  closeImagePreview();

  const overlay = document.createElement('div');
  overlay.className = 'md-image-preview';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt ? `Image preview: ${alt}` : 'Image preview');

  const image = document.createElement('img');
  image.className = 'md-image-preview__image';
  image.src = src;
  image.alt = alt;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'md-image-preview__close';
  close.setAttribute('aria-label', 'Close image preview');
  close.textContent = '×';

  overlay.append(image, close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target === close) closeImagePreview();
  });
  activeImagePreviewKeyHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || activeImagePreview !== overlay) return;
    closeImagePreview();
  };
  document.addEventListener('keydown', activeImagePreviewKeyHandler);

  document.body.appendChild(overlay);
  activeImagePreview = overlay;
  close.focus();
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
 * @param sessionId      Current session, used to open the matching Workspace IDE
 */
export function handlePathClick(e: MouseEvent, workspacePath: string, sessionId?: string | null): void {
  let target = e.target as HTMLElement | null;
  if (!target) return;

  const api = getAPI();

  // Walk up to find .clickable-path or a[data-external-url]
  while (target) {
    // Images open in an in-app full-size preview. This works for remote URLs,
    // data URLs, raw tool screenshots, and workspace images served by AnoClaw.
    if (target.tagName === 'IMG') {
      const image = target as HTMLImageElement;
      const src = image.currentSrc || image.src;
      if (!src || image.style.display === 'none') return;
      e.preventDefault();
      showImagePreview(src, image.alt || '');
      return;
    }

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

      const workspaceRelativePath = resolveWorkspaceRelativePath(rawPath, workspacePath);
      if (workspaceRelativePath) {
        const line = Number.parseInt(target.getAttribute('data-file-line') || '', 10);
        const column = Number.parseInt(target.getAttribute('data-file-column') || '', 10);
        window.dispatchEvent(new CustomEvent('ws-open-workspace-file', {
          detail: {
            path: workspaceRelativePath,
            sessionId: sessionId || undefined,
            line: Number.isFinite(line) && line > 0 ? line : undefined,
            column: Number.isFinite(column) && column > 0 ? column : undefined,
          },
        }));
        return;
      }

      // Absolute paths outside the bound workspace cannot be read by the
      // session-scoped IDE API. Preserve the desktop system-handler fallback.
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
