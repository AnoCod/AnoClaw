
// Slash command popup, attachment chips, file upload, mode selector.

import { goalPermissionModeToUi, type Attachment, type GoalContractDraft, type GoalState } from './types.js';
import { SlashCommandPanel } from './SlashCommandPanel.js';
import { loadCommandsFromApi, INIT_PROTOCOL_PROMPT } from './SlashCommands.js';
import { ModeSelector } from './ModeSelector.js';
import { Dialog } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { CommandDefinition } from '../../types.js';
import { App } from '../../app.js';
import { ClientLogger } from '../../ClientLogger.js';
import { ToastManager } from '../../ToastManager.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';

const SVG_ATTACH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9.5 4v7a3 3 0 1 1-6 0V4.5a2 2 0 0 1 4 0v6a1 1 0 0 1-2 0V4"/></svg>`;
const SVG_ATTACHMENT_FILE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const SVG_REMOVE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;


export class InputPanel {
  readonly element: HTMLElement;
  private _textarea: HTMLTextAreaElement;
  private _sendBtn: HTMLButtonElement;
  private _stopBtn: HTMLButtonElement;
  private _attachBtn: HTMLButtonElement;
  private _modeSelector: ModeSelector;
  private _attachmentsBar: HTMLElement;
  private _goalCard: HTMLElement;
  private _goalDetailsDialog: Dialog | null = null;
  private _slashPanel: SlashCommandPanel;
  private _commands: CommandDefinition[] = [];
  private _attachments: Attachment[] = [];
  private _goal: GoalState | null = null;
  private _goalPending = false;
  private _goalError: string | null = null;
  private _currentMode: string = 'auto';
  isStreaming = false;

  onSend: ((content: string, mode: string, attachments: Attachment[]) => void) | null = null;
  onStop: (() => void) | null = null;

  constructor() {
    // Build DOM elements
    this._textarea = this._makeTextarea();
    this._sendBtn = this._makeSendBtn();
    this._stopBtn = this._makeStopBtn();
    this._attachBtn = this._makeAttachBtn();
    this._modeSelector = new ModeSelector('auto', true);
    this._attachmentsBar = this._makeAttachmentsBar();
    this._goalCard = this._makeGoalCard();
    this._slashPanel = new SlashCommandPanel();
    this.element = this._build();

    // Wire mode selector to ConversationViewModel permission + running mode state
    const convVM = App.getInstance().conversationVM;
    this._goal = convVM.goal;
    this._goalPending = convVM.goalPending;
    this._goalError = convVM.goalError;
    this._currentMode = convVM.permissionMode;
    this._modeSelector.setMode(this._currentMode as any, false);
    this._modeSelector.setGoal(this._goal as any);
    this._goalCard.addEventListener('click', (event) => {
      handlePathClick(
        event as MouseEvent,
        this._goal?.workspace || this._goal?.lastWorkspace || '',
        convVM.getActiveSessionId(),
      );
    });
    this._modeSelector.onModeChange = (mode) => {
      console.log('[Input] Mode changed', { mode });
      this._currentMode = mode;
      convVM.setPermissionMode(mode === 'ask' ? 'ask' : mode === 'plan' ? 'plan' : mode === 'auto-edit' ? 'auto-edit' : 'auto');
    };
    this._modeSelector.onEffortChange = (enabled) => {
      convVM.setEffortMode(enabled);
    };
    this._modeSelector.onGoalAction = (action) => {
      this._handleGoalAction(action).catch((err) => {
        ClientLogger.ui.error('Goal action failed', { error: (err as Error).message });
      });
    };
    convVM.on('permissionModeChanged', (mode: string) => {
      this._currentMode = mode;
      this._modeSelector.setMode(mode as any, false);
    });
    convVM.on('effortModeChanged', (enabled: boolean) => {
      this._modeSelector.setEffort(enabled, false);
    });
    convVM.on('goalChanged', (goal: unknown) => {
      this._goal = goal as GoalState | null;
      this._goalError = null;
      this._modeSelector.setGoal(this._goal as any);
      if ((!this._goal || this._goal.status === 'deleted') && this._goalDetailsDialog) {
        this._closeGoalDetails();
      }
      this._renderGoalCard();
    });
    convVM.on('goalPendingChanged', (pending: boolean) => {
      this._goalPending = pending;
      this._renderGoalCard();
    });
    convVM.on('goalError', (message: string) => {
      this._goalError = message;
      ClientLogger.ui.warn('Goal update failed', { message });
      ToastManager.getInstance().error(message);
      this._renderGoalCard();
    });
    this._renderGoalCard();

    // Load slash command definitions from API, wire selection to textarea insertion
    loadCommandsFromApi().then(cmds => { this._commands = cmds; }).catch(() => {});
    this._slashPanel.on('commandSelected', (name: string) => {
      this._insertCommand(name);
    });
  }


  private _build(): HTMLElement {
    const area = document.createElement('div');
    area.className = 'cinema-input-area';

    // Goal is intentionally not rendered above the textarea. Its single entry
    // lives in the Mode menu and opens an on-demand details dialog.
    area.appendChild(this._attachmentsBar);

    // Textarea (fills remaining space, grows with content)
    area.appendChild(this._textarea);

    // Button bar (fixed below textarea)
    const bar = document.createElement('div');
    bar.className = 'cinema-input-bar';
    bar.appendChild(this._modeSelector.element);
    bar.appendChild(this._attachBtn);
    bar.appendChild(this._sendBtn);
    bar.appendChild(this._stopBtn);
    area.appendChild(bar);

    return area;
  }



  private _makeTextarea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.className = 'cinema-textarea';
    ta.placeholder = 'Message AnoClaw...';
    ta.rows = 1;
    let heightRaf = 0;
    ta.addEventListener('input', () => {
      if (!heightRaf) {
        heightRaf = requestAnimationFrame(() => {
          heightRaf = 0;
          ta.style.height = 'auto';
          ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        });
      }
      this._checkSlash();
    });
    ta.addEventListener('keydown', (e) => {
      if (this._slashPanel.isOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._slashPanel.moveDown(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this._slashPanel.moveUp(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const cmd = this._slashPanel.selectedCommand;
          if (cmd) this._insertCommand(cmd.name);
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); this._slashPanel.close(); return; }
        if (e.key === 'Tab') { e.preventDefault(); this._slashPanel.close(); return; }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._fireSend();
      }
    });
    // Close slash panel only on genuine focus-leave (e.g. click on a focusable
    // element elsewhere). Do NOT close on involuntary blur (relatedTarget=null)

    // click-outside handler covers the case where the user clicks a non-focusable
    // element.
    ta.addEventListener('focusout', (e) => {
      const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (!related) return;

      if (this.element.contains(related)) return;

      if (this._slashPanel.containsElement(related)) return;

      setTimeout(() => {
        if (this._slashPanel.isOpen) this._slashPanel.close();
      }, 150);
    });
    return ta;
  }



  // Find the last '/' before cursor, open/filter the slash command popup
  private _checkSlash(): void {
    const val = this._textarea.value;
    const cursor = this._textarea.selectionStart || 0;
    const beforeCursor = val.slice(0, cursor);
    const lastSlash = beforeCursor.lastIndexOf('/');
    if (lastSlash === -1) { this._slashPanel.close(); return; }
    if (lastSlash > 0 && !/\s/.test(beforeCursor[lastSlash - 1])) { this._slashPanel.close(); return; }
    const query = beforeCursor.slice(lastSlash + 1);

    if (!this._slashPanel.isOpen) {
      this._slashPanel.open(this._textarea, this._commands, query);
    } else {
      this._slashPanel.filter(query);
    }
  }

  // Replace the /query text at cursor with the selected command name
  private _insertCommand(name: string): void {
    const val = this._textarea.value;
    const cursor = this._textarea.selectionStart || 0;
    const beforeCursor = val.slice(0, cursor);
    const lastSlash = beforeCursor.lastIndexOf('/');
    const afterCursor = val.slice(cursor);
    const newVal = beforeCursor.slice(0, lastSlash) + '/' + name + ' ' + afterCursor;
    this._textarea.value = newVal;
    this._textarea.style.height = 'auto';
    this._textarea.style.height = `${Math.min(this._textarea.scrollHeight, 200)}px`;
    this._textarea.focus();
    this._slashPanel.close();
  }


  // This is NOT for changing the workspace directory (see Workspace page "Switch..." button).

  private _makeAttachBtn(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'cinema-tool-btn';
    btn.innerHTML = SVG_ATTACH;
    btn.title = 'Attach files';
    btn.addEventListener('click', () => this._openFilePicker());
    return btn;
  }

  // Open native file picker, read text files content, store as Attachment objects
  private _openFilePicker(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';

    const cleanup = () => {
      input.remove();
      window.removeEventListener('focus', cleanup);
    };

    input.addEventListener('change', () => {
      if (!input.files) { cleanup(); return; }
      for (const file of Array.from(input.files)) {
        const isText = file.type.startsWith('text/')
          || /\.(txt|md|json|js|ts|jsx|tsx|css|scss|less|html|xml|yaml|yml|toml|ini|cfg|conf|log|sh|bash|zsh|py|rb|rs|go|java|kt|swift|c|cpp|h|hpp|sql|r|env|gitignore|editorconfig)$/i.test(file.name);
        if (!isText) {
          this._attachments.push({ name: file.name, path: file.name, type: file.type || 'application/octet-stream', size: file.size });
          this._renderAttachments();
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          this._attachments.push({
            name: file.name,
            path: file.name,
            type: file.type || 'text/plain',
            size: file.size,
            content: content.slice(0, 50_000),
          });
          this._renderAttachments();
        };
        reader.readAsText(file);
      }
      cleanup();
    });

    // Also cleanup when user cancels (window regains focus without change event)
    window.addEventListener('focus', cleanup, { once: true });
    document.body.appendChild(input);
    input.click();
  }



  private _makeAttachmentsBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'input-attachments-bar';
    return bar;
  }


  private _renderAttachments(): void {
    this._attachmentsBar.innerHTML = '';
    if (this._attachments.length === 0) {
      this._attachmentsBar.classList.remove('visible');
      return;
    }
    this._attachmentsBar.classList.add('visible');
    for (let i = 0; i < this._attachments.length; i++) {
      const att = this._attachments[i];
      const tag = document.createElement('span');
      tag.className = 'attachment-tag';

      const icon = document.createElement('span');
      icon.className = 'attachment-tag-icon';
      icon.innerHTML = SVG_ATTACHMENT_FILE;
      tag.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'attachment-tag-name';
      name.textContent = att.name;
      tag.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-tag-remove';
      remove.innerHTML = SVG_REMOVE;
      remove.title = 'Remove attachment';
      remove.setAttribute('aria-label', `Remove ${att.name}`);
      remove.dataset.index = String(i);
      remove.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement);
        const idx = Number(target.dataset.index);
        if (!isNaN(idx) && idx < this._attachments.length) {
          this._attachments.splice(idx, 1);
          this._renderAttachments();
        }
      });
      tag.appendChild(remove);

      this._attachmentsBar.appendChild(tag);
    }
  }


  // Goal controls

  private _makeGoalCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'input-goal-card';
    return card;
  }

  private _renderGoalCard(): void {
    this._goalCard.replaceChildren();
    if (!this._goal || this._goal.status === 'deleted') {
      this._goalCard.className = 'input-goal-card';
      return;
    }

    const isActive = this._goal.status === 'active';
    this._goalCard.className = `input-goal-card visible goal-${this._goal.status}`;
    this._goalCard.setAttribute('role', 'status');
    this._goalCard.setAttribute('aria-live', 'polite');

    const main = document.createElement('div');
    main.className = 'input-goal-card-main';

    const status = document.createElement('div');
    status.className = 'input-goal-status';
    const dot = document.createElement('span');
    dot.className = 'input-goal-dot';
    dot.setAttribute('aria-hidden', 'true');
    const statusText = document.createElement('span');
    statusText.textContent = `${this._goalStatusLabel(this._goal.status)}${this._goalPending ? ' · Updating…' : ''}`;
    status.appendChild(dot);
    status.appendChild(statusText);

    const summary = document.createElement('div');
    summary.className = 'input-goal-summary';
    summary.textContent = this._goalSummary(this._goal.objective);
    summary.title = this._goal.objective;

    const actions = document.createElement('div');
    actions.className = 'input-goal-actions';
    if (isActive || this._goal.status === 'waiting_confirmation' || this._goal.status === 'waiting_user') {
      actions.appendChild(this._makeGoalActionBtn('Pause', 'pause'));
    } else if (this._goal.status === 'waiting_review') {
      actions.appendChild(this._makeGoalActionBtn('Accept', 'complete', true));
      actions.appendChild(this._makeGoalActionBtn('Continue', 'resume'));
    } else if (this._goal.status === 'budget_exhausted') {
      actions.appendChild(this._makeGoalActionBtn('Edit limits', 'edit', true));
    } else if (this._goal.status !== 'completed') {
      actions.appendChild(this._makeGoalActionBtn('Resume', 'resume'));
    } else {
      actions.appendChild(this._makeGoalActionBtn('Reopen', 'resume'));
    }
    main.appendChild(status);
    main.appendChild(summary);
    main.appendChild(actions);
    this._goalCard.appendChild(main);
    if (this._goalError) {
      const error = document.createElement('div');
      error.className = 'input-goal-inline-error';
      error.textContent = this._goalError;
      this._goalCard.appendChild(error);
    }

    if (typeof this._goal.progress === 'number') {
      const progress = document.createElement('div');
      progress.className = 'input-goal-progress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.setAttribute('aria-valuenow', String(this._goal.progress));
      const bar = document.createElement('span');
      bar.style.width = `${Math.max(0, Math.min(100, this._goal.progress))}%`;
      progress.appendChild(bar);
      this._goalCard.appendChild(progress);
    }

    {
      const detail = document.createElement('div');
      detail.className = 'input-goal-detail-grid';
      this._appendGoalDetail(detail, 'Outcome', this._goal.objective);
      this._appendGoalDetail(detail, 'Done when', this._goal.acceptanceCriteria || 'Not specified');
      if (this._goal.lastSummary) this._appendGoalDetail(detail, 'Latest result', this._goal.lastSummary);
      if (this._goal.nextStep) this._appendGoalDetail(detail, 'Next step', this._goal.nextStep);
      if (this._goal.statusReason) this._appendGoalDetail(detail, 'Status reason', this._goal.statusReason);
      if (this._goal.lastError) this._appendGoalDetail(detail, 'Last error', this._goal.lastError, true);
      this._goalCard.appendChild(detail);

      const contextItems = [
        `Mode ${this._modeLabel(this._goal.permissionMode || this._goal.lastPermissionMode || 'Auto')}`,
        this._goal.lastEffort ? `Effort ${this._goal.lastEffort}` : '',
        `Workspace ${this._shortPath(this._goal.workspace || this._goal.lastWorkspace || '')}`,
        `Runs ${this._goal.runCount || 0}/${this._goal.maxRuns || 20}`,
        this._goal.consecutiveFailures ? `Failures ${this._goal.consecutiveFailures}/${this._goal.maxConsecutiveFailures}` : '',
      ].filter(Boolean);
      if (contextItems.length > 0) {
        const context = document.createElement('div');
        context.className = 'input-goal-context';
        for (const item of contextItems) {
          const chip = document.createElement('span');
          chip.className = 'input-goal-context-chip';
          chip.textContent = item;
          if (item.startsWith('Workspace ')) chip.title = this._goal.workspace || this._goal.lastWorkspace || '';
          context.appendChild(chip);
        }
        this._goalCard.appendChild(context);
      }

      if (this._goal.evidence?.length) {
        const evidence = document.createElement('div');
        evidence.className = 'input-goal-evidence';
        const heading = document.createElement('div');
        heading.className = 'input-goal-evidence-title';
        heading.textContent = 'Evidence';
        evidence.appendChild(heading);
        for (const item of this._goal.evidence) {
          if (item.type === 'image' && item.path) {
            const preview = document.createElement('img');
            preview.className = 'input-goal-evidence-preview';
            preview.alt = item.label;
            preview.loading = 'lazy';
            preview.src = `/api/v1/workspace/read?path=${encodeURIComponent(item.path)}&sessionId=${encodeURIComponent(App.getInstance().conversationVM.getActiveSessionId() || '')}&raw=1`;
            preview.title = 'Click to preview';
            preview.setAttribute('data-file-path', item.path);
            preview.addEventListener('error', () => { preview.style.display = 'none'; });
            evidence.appendChild(preview);
          }
          const row = document.createElement(item.url ? 'a' : 'button');
          row.className = `input-goal-evidence-item evidence-${item.type}`;
          if (row instanceof HTMLButtonElement) row.type = 'button';
          row.textContent = item.label;
          row.title = item.detail || item.path || item.url || item.label;
          if (item.path) {
            row.classList.add('clickable-path');
            row.setAttribute('data-file-path', item.path);
          } else if (item.url && row instanceof HTMLAnchorElement) {
            row.href = item.url;
            row.target = '_blank';
            row.rel = 'noopener noreferrer';
            row.setAttribute('data-external-url', '');
          }
          evidence.appendChild(row);
        }
        this._goalCard.appendChild(evidence);
      }

      const footerActions = document.createElement('div');
      footerActions.className = 'input-goal-footer-actions';
      footerActions.appendChild(this._makeGoalActionBtn('Edit contract', 'edit'));
      footerActions.appendChild(this._makeGoalActionBtn('Delete', 'delete'));
      this._goalCard.appendChild(footerActions);

      const meta = document.createElement('div');
      meta.className = 'input-goal-meta';
      const updated = this._goal.updatedAt ? new Date(this._goal.updatedAt).toLocaleString() : '';
      const lastRun = this._goal.lastRunAt ? new Date(this._goal.lastRunAt).toLocaleString() : '';
      meta.textContent = [
        updated ? `Updated ${updated}` : '',
        lastRun ? `Last run ${lastRun}` : '',
      ].filter(Boolean).join(' / ');
      if (meta.textContent) this._goalCard.appendChild(meta);
    }
  }

  private _goalStatusLabel(status: GoalState['status']): string {
    switch (status) {
      case 'active': return 'Goal running';
      case 'paused': return 'Goal paused';
      case 'waiting_user': return 'Needs your input';
      case 'waiting_confirmation': return 'Approval required';
      case 'waiting_review': return 'Ready for review';
      case 'blocked': return 'Goal blocked';
      case 'failed': return 'Goal stopped after failures';
      case 'budget_exhausted': return 'Run limit reached';
      case 'completed': return 'Goal completed';
      default: return 'Goal';
    }
  }

  private _appendGoalDetail(container: HTMLElement, labelText: string, value: string, isError = false): void {
    const row = document.createElement('div');
    row.className = `input-goal-detail-row${isError ? ' is-error' : ''}`;
    const label = document.createElement('span');
    label.textContent = labelText;
    const content = document.createElement('div');
    content.textContent = value;
    row.appendChild(label);
    row.appendChild(content);
    container.appendChild(row);
  }

  private _modeLabel(value: string): string {
    switch (value) {
      case 'Ask': return 'Ask';
      case 'AutoEdit': return 'Auto Edit';
      case 'Plan': return 'Plan';
      case 'Auto': return 'Safe Auto';
      default: return value;
    }
  }

  private _shortPath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 2) return value;
    return `.../${parts.slice(-2).join('/')}`;
  }

  private _showGoalDetails(): void {
    if (!this._goal || this._goal.status === 'deleted') {
      this._showGoalDialog('start');
      return;
    }
    this._closeGoalDetails();
    this._renderGoalCard();
    const body = document.createElement('div');
    body.className = 'goal-details-body';
    body.appendChild(this._goalCard);

    let detailsDialog: Dialog;
    detailsDialog = new Dialog({
      title: 'Goal',
      body,
      width: 'min(720px, calc(100vw - 32px))',
      onClose: () => {
        if (this._goalDetailsDialog === detailsDialog) this._goalDetailsDialog = null;
      },
    });
    this._goalDetailsDialog = detailsDialog;
    detailsDialog.show();
  }

  private _closeGoalDetails(): void {
    const dialog = this._goalDetailsDialog;
    this._goalDetailsDialog = null;
    dialog?.close();
  }

  private _makeGoalActionBtn(
    label: string,
    action: 'start' | 'pause' | 'resume' | 'edit' | 'complete' | 'delete',
    primary = false,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cinema-tool-btn input-goal-action-btn${primary ? ' is-primary' : ''}`;
    btn.textContent = label;
    btn.disabled = this._goalPending;
    btn.addEventListener('click', () => {
      this._handleGoalAction(action).catch((err) => {
        ClientLogger.ui.error('Goal action failed', { error: (err as Error).message });
      });
    });
    return btn;
  }

  private async _handleGoalAction(action: 'start' | 'view' | 'pause' | 'resume' | 'edit' | 'complete' | 'delete'): Promise<void> {
    const convVM = App.getInstance().conversationVM;
    if (action === 'view') {
      this._showGoalDetails();
      return;
    }
    if (action === 'start' || action === 'edit') {
      if (action === 'edit') this._closeGoalDetails();
      this._showGoalDialog(action);
      return;
    }
    if (action === 'complete') {
      const ok = await ConfirmDialog.show('Accept the evidence and mark this Goal complete?', 'Complete Goal');
      if (!ok) return;
    }
    if (action === 'delete') {
      const ok = await ConfirmDialog.show('Delete this goal?', 'Delete Goal');
      if (!ok) return;
      this._closeGoalDetails();
    }
    convVM.setGoal(action);
  }

  private _showGoalDialog(action: 'start' | 'edit'): void {
    const convVM = App.getInstance().conversationVM;
    const body = document.createElement('div');
    body.className = 'goal-dialog-body';
    const idPrefix = `goal-contract-${Date.now()}`;
    const activeWorkspace = convVM.getSessionVM()?.activeSession?.workspace || '';
    // A new Goal always binds to the current session workspace. Editing keeps
    // the existing Goal workspace unless it is missing (legacy migrations).
    const currentWorkspace = action === 'edit'
      ? (this._goal?.workspace || activeWorkspace)
      : activeWorkspace;

    const addField = (labelText: string, control: HTMLElement, hintText?: string): HTMLElement => {
      const field = document.createElement('div');
      field.className = 'ui-form-field goal-dialog-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      if (control.id) label.htmlFor = control.id;
      field.appendChild(label);
      field.appendChild(control);
      if (hintText) {
        const hint = document.createElement('div');
        hint.className = 'goal-dialog-hint';
        hint.textContent = hintText;
        field.appendChild(hint);
      }
      return field;
    };

    const objective = document.createElement('textarea');
    objective.id = `${idPrefix}-objective`;
    objective.className = 'ui-textarea goal-dialog-textarea';
    objective.rows = 4;
    objective.placeholder = 'What concrete result should AnoClaw deliver?';
    objective.value = this._goal?.objective || '';
    body.appendChild(addField('Outcome', objective, 'Describe the result, not only the activity.'));

    const criteria = document.createElement('textarea');
    criteria.id = `${idPrefix}-criteria`;
    criteria.className = 'ui-textarea goal-dialog-criteria';
    criteria.rows = 3;
    criteria.placeholder = 'How can AnoClaw and you verify that this is done?';
    criteria.value = this._goal?.acceptanceCriteria || '';
    body.appendChild(addField('Done when', criteria, 'Use observable evidence such as files, tests, reports, or a reviewed result.'));

    const workspace = document.createElement('input');
    workspace.id = `${idPrefix}-workspace`;
    workspace.className = 'ui-input';
    workspace.type = 'text';
    workspace.value = currentWorkspace;
    workspace.readOnly = true;
    workspace.title = currentWorkspace;
    body.appendChild(addField('Workspace', workspace, 'This Goal stays bound to this Workspace until you edit its contract.'));

    const controls = document.createElement('div');
    controls.className = 'goal-dialog-grid';

    const maxRuns = document.createElement('input');
    maxRuns.id = `${idPrefix}-runs`;
    maxRuns.className = 'ui-input';
    maxRuns.type = 'number';
    maxRuns.min = '1';
    maxRuns.max = '1000';
    maxRuns.value = String(this._goal?.maxRuns || 20);
    controls.appendChild(addField('Maximum runs', maxRuns));

    const failures = document.createElement('input');
    failures.id = `${idPrefix}-failures`;
    failures.className = 'ui-input';
    failures.type = 'number';
    failures.min = '1';
    failures.max = '20';
    failures.value = String(this._goal?.maxConsecutiveFailures || 3);
    controls.appendChild(addField('Failure limit', failures));

    const cadence = document.createElement('select');
    cadence.id = `${idPrefix}-cadence`;
    cadence.className = 'ui-select';
    for (const [value, label] of [['15000', '15 seconds'], ['60000', '1 minute'], ['300000', '5 minutes'], ['900000', '15 minutes']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      cadence.appendChild(option);
    }
    cadence.value = String(this._goal?.wakeIntervalMs || 15000);
    controls.appendChild(addField('Between runs', cadence));

    body.appendChild(controls);

    const safety = document.createElement('div');
    safety.className = 'goal-dialog-safety';
    safety.textContent = 'Goal always runs in Auto Edit: every allowed tool is pre-authorized and no tool approval pop-ups are shown. It can still stop for user input, completion review, blockers, repeated failures, or the run limit.';
    body.appendChild(safety);

    const footer = document.createElement('div');
    footer.className = 'goal-dialog-actions';
    let dialog: Dialog | null = null;
    const cancelBtn = new Button({ label: 'Cancel', onClick: () => dialog?.close() });
    const submitBtn = new Button({
      label: action === 'edit' ? 'Change' : 'Start',
      variant: 'primary',
      onClick: () => {
        if (!objective.value.trim() || !criteria.value.trim()) return;
        const contract: GoalContractDraft = {
          objective: objective.value.trim(),
          acceptanceCriteria: criteria.value.trim(),
          workspace: currentWorkspace,
          maxRuns: Number(maxRuns.value),
          maxConsecutiveFailures: Number(failures.value),
          wakeIntervalMs: Number(cadence.value),
          completionMode: 'review',
        };
        convVM.setGoal(action, contract);
        dialog?.close();
      },
    });
    const updateSubmit = () => {
      submitBtn.disabled = !objective.value.trim() || !criteria.value.trim();
    };
    updateSubmit();
    objective.addEventListener('input', updateSubmit);
    criteria.addEventListener('input', updateSubmit);
    objective.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !submitBtn.disabled) {
        e.preventDefault();
        submitBtn.element.click();
      }
    });
    footer.appendChild(cancelBtn.element);
    footer.appendChild(submitBtn.element);

    dialog = new Dialog({
      title: action === 'edit' ? 'Edit Goal' : 'Start Goal',
      body,
      footer,
      width: '660px',
    });
    dialog.show();
    setTimeout(() => objective.focus(), 0);
  }

  private _goalSummary(objective: string): string {
    const oneLine = objective.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 120) return oneLine;
    return `${oneLine.slice(0, 117).trim()}...`;
  }



  private _makeSendBtn(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'cinema-tool-btn is-primary';
    btn.textContent = 'SEND';
    btn.addEventListener('click', () => this._fireSend());
    return btn;
  }

  private _makeStopBtn(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'cinema-tool-btn is-stop';
    btn.textContent = 'STOP';
    btn.style.display = 'none';
    btn.addEventListener('click', () => {
      if (this.onStop) this.onStop();
    });
    return btn;
  }



  // Toggle between send mode (attach+mode visible) and streaming mode (stop visible, input dimmed)
  setStreaming(v: boolean): void {
    this.isStreaming = v;
    // During streaming: keep textarea writable for soft interrupt, show send button
    this._sendBtn.style.display = '';
    this._stopBtn.style.display = v ? '' : 'none';
    this._attachBtn.style.display = v ? 'none' : '';
    this._modeSelector.element.style.display = v ? 'none' : '';
    // Subtle visual cue that agent is working, but keep input fully functional
    this._textarea.style.opacity = v ? '0.7' : '';
  }



  // Clear textarea and attachments, then fire onSend with content + mode + attachments
  private _fireSend(): void {
    let content = this._textarea.value.trim();
    if (!content && this._attachments.length === 0) return;
    console.log('[Input] fireSend', { contentLen: content.length, attachments: this._attachments.length });
    if (this._attachments.length === 0 && this._tryRunSlashCommand(content)) {
      this._textarea.value = '';
      this._textarea.style.height = 'auto';
      this._slashPanel.close();
      return;
    }
    // Re-read in case _tryRunSlashCommand rewrote the textarea (e.g. /init)
    content = this._textarea.value.trim() || content;
    const attachments = [...this._attachments];
    this._textarea.value = '';
    this._textarea.style.height = 'auto';
    this._attachments = [];
    this._renderAttachments();
    if (this.onSend) {
      ClientLogger.ui.debug('Input send', { len: content.length, attachments: attachments.length });
      this.onSend(content, this._effectiveSendMode(), attachments);
    }
  }

  private _tryRunSlashCommand(content: string): boolean {
    const match = content.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
    if (!match) return false;
    const [, command, rawArgs] = match;

    // /init requires the agent to explore workspace and write anoclaw.md.
    // Send the init protocol as a normal message so the agent participates.
    if (command === 'init') {
      this._textarea.value = '';
      this._textarea.style.height = 'auto';
      this._slashPanel.close();
      if (this.onSend) {
        this.onSend(INIT_PROTOCOL_PROMPT, this._effectiveSendMode(), []);
      }
      return true;
    }

    const args = rawArgs ? { raw: rawArgs } : undefined;
    ClientLogger.ui.debug('Slash command run', { command });
    App.getInstance().conversationVM.runCommand(command, args);
    return true;
  }

  focus(): void { this._textarea.focus(); }
  setValue(val: string): void { this._textarea.value = val; this._textarea.style.height = 'auto'; this._textarea.style.height = `${Math.min(this._textarea.scrollHeight, 200)}px`; }
  restoreDraft(content: string, attachments: Attachment[]): void {
    this.setValue(content);
    this._attachments = [...attachments];
    this._renderAttachments();
  }
  clear(): void { this._textarea.value = ''; this._textarea.style.height = 'auto'; }
  clearAttachments(): void { this._attachments = []; this._renderAttachments(); }

  private _effectiveSendMode(): string {
    if (this._goal?.status === 'active') {
      return goalPermissionModeToUi(this._goal.permissionMode, this._currentMode as 'ask' | 'auto-edit' | 'plan' | 'auto');
    }
    return this._currentMode;
  }
}


