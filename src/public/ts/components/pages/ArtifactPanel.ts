import { App } from '../../app.js';
import type { ArtifactFile, ArtifactRecord } from '../../types.js';
import type { SessionAgent } from '../../viewmodel/SessionAgent.js';

const SVG_DOWNLOAD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;
const SVG_REFRESH = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/></svg>`;

export class ArtifactPanel {
  private _agent: SessionAgent | null = null;
  private _listEl: HTMLElement;
  private _statusEl: HTMLElement;
  private _loading = false;

  private _onArtifactsLoaded = () => this._render();
  private _onArtifactUpdated = () => this._render();

  constructor(private readonly _container: HTMLElement, private readonly _sessionId: string | null) {
    this._container.classList.add('artifact-panel');
    this._container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'artifact-panel-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'cinema-overfly-title artifact-panel-title';
    title.textContent = 'Artifacts';
    const subtitle = document.createElement('div');
    subtitle.className = 'artifact-panel-subtitle';
    subtitle.textContent = 'Generated files and previews for this session';
    titleWrap.append(title, subtitle);

    const refresh = document.createElement('button');
    refresh.className = 'artifact-icon-button';
    refresh.type = 'button';
    refresh.title = 'Refresh artifacts';
    refresh.innerHTML = SVG_REFRESH;
    refresh.addEventListener('click', () => this.refresh());

    header.append(titleWrap, refresh);
    this._container.appendChild(header);

    this._statusEl = document.createElement('div');
    this._statusEl.className = 'artifact-panel-status';
    this._container.appendChild(this._statusEl);

    this._listEl = document.createElement('div');
    this._listEl.className = 'artifact-list';
    this._container.appendChild(this._listEl);

    if (this._sessionId) {
      this._agent = App.getInstance().conversationVM.getAgent(this._sessionId);
      this._agent.on('artifactsLoaded', this._onArtifactsLoaded);
      this._agent.on('artifactUpdated', this._onArtifactUpdated);
      this._render();
      this.refresh();
    } else {
      this._renderEmpty('Select a session to see generated artifacts.');
    }
  }

  dispose(): void {
    if (!this._agent) return;
    this._agent.off('artifactsLoaded', this._onArtifactsLoaded);
    this._agent.off('artifactUpdated', this._onArtifactUpdated);
    this._agent = null;
  }

  async refresh(): Promise<void> {
    if (!this._agent || this._loading) return;
    this._loading = true;
    this._statusEl.textContent = 'Refreshing...';
    try {
      await this._agent.loadArtifacts();
      this._statusEl.textContent = '';
    } catch (err) {
      this._statusEl.textContent = `Failed to load artifacts: ${(err as Error).message}`;
    } finally {
      this._loading = false;
      this._render();
    }
  }

  private _render(): void {
    const artifacts = this._agent?.state.artifacts || [];
    this._listEl.innerHTML = '';
    if (artifacts.length === 0) {
      this._renderEmpty(this._loading ? 'Loading artifacts...' : 'No artifacts yet. Ask AnoClaw to create a PPT, report, image, or analysis.');
      return;
    }

    for (const artifact of artifacts) {
      this._listEl.appendChild(this._renderArtifact(artifact));
    }
  }

  private _renderEmpty(message: string): void {
    this._listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'artifact-empty';
    empty.textContent = message;
    this._listEl.appendChild(empty);
  }

  private _renderArtifact(artifact: ArtifactRecord): HTMLElement {
    const card = document.createElement('article');
    card.className = `artifact-card artifact-card--${artifact.status}`;

    const header = document.createElement('div');
    header.className = 'artifact-card-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'artifact-card-title-wrap';
    const title = document.createElement('div');
    title.className = 'artifact-card-title';
    title.textContent = artifact.title || 'Untitled artifact';
    const meta = document.createElement('div');
    meta.className = 'artifact-card-meta';
    meta.textContent = `${labelKind(artifact.kind)} · ${formatTime(artifact.updatedAt || artifact.createdAt)}`;
    titleWrap.append(title, meta);

    const status = document.createElement('span');
    status.className = `artifact-status artifact-status--${artifact.status}`;
    status.textContent = artifact.status;
    header.append(titleWrap, status);
    card.appendChild(header);

    if (artifact.description) {
      const desc = document.createElement('div');
      desc.className = 'artifact-description';
      desc.textContent = artifact.description;
      card.appendChild(desc);
    }

    const preview = previewText(artifact);
    if (preview) {
      const pre = document.createElement('pre');
      pre.className = 'artifact-preview';
      pre.textContent = preview;
      card.appendChild(pre);
    }

    if (artifact.files.length > 0) {
      const files = document.createElement('div');
      files.className = 'artifact-files';
      artifact.files.forEach((file, index) => {
        files.appendChild(this._renderFileLink(artifact, file, index));
      });
      card.appendChild(files);
    }

    return card;
  }

  private _renderFileLink(artifact: ArtifactRecord, file: ArtifactFile, index: number): HTMLElement {
    const link = document.createElement('a');
    link.className = 'artifact-download';
    link.href = `/api/v1/artifacts/${encodeURIComponent(artifact.sessionId)}/${encodeURIComponent(artifact.id)}/files/${index}`;
    link.download = downloadName(file);
    link.title = file.path;

    const icon = document.createElement('span');
    icon.className = 'artifact-download-icon';
    icon.innerHTML = SVG_DOWNLOAD;
    const text = document.createElement('span');
    text.textContent = file.label || downloadName(file);
    const size = document.createElement('span');
    size.className = 'artifact-download-size';
    size.textContent = formatSize(file.sizeBytes);
    link.append(icon, text, size);
    return link;
  }
}

function previewText(artifact: ArtifactRecord): string {
  const preview = artifact.preview;
  if (!preview?.content) return '';
  if (preview.type === 'json') {
    try {
      return JSON.stringify(JSON.parse(preview.content), null, 2).slice(0, 1200);
    } catch {
      return preview.content.slice(0, 1200);
    }
  }
  return preview.content.slice(0, 1200);
}

function labelKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTime(value: string): string {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'Just now';
  const diff = Date.now() - time;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`;
  return new Date(time).toLocaleDateString();
}

function formatSize(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function downloadName(file: ArtifactFile): string {
  const fromPath = file.path.split(/[\\/]/).pop() || 'artifact';
  if (!file.label) return fromPath;
  return /\.[a-z0-9]{2,8}$/i.test(file.label) ? file.label : fromPath;
}
