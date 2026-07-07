// AnoClaw Cinema 鈥?InputPanel: textarea (top) + unified button bar (bottom).
// Slash command popup, attachment chips, file upload, mode selector.

import type { Attachment, GoalState } from './types.js';
import { SlashCommandPanel } from './SlashCommandPanel.js';
import { loadCommandsFromApi, INIT_PROTOCOL_PROMPT } from './SlashCommands.js';
import { ModeSelector } from './ModeSelector.js';
import { Dialog } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { CommandDefinition } from '../../types.js';
import { App } from '../../app.js';
import { ClientLogger } from '../../ClientLogger.js';

const SVG_ATTACH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9.5 4v7a3 3 0 1 1-6 0V4.5a2 2 0 0 1 4 0v6a1 1 0 0 1-2 0V4"/></svg>`;
const SVG_ATTACHMENT_FILE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const SVG_REMOVE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/**
 * Unified input panel: textarea + send/stop buttons + mode selector + attachments bar + slash command popup.
 *
 * Send flow: user types text (optionally with /commands) and attaches files,
 * presses Enter or clicks SEND 鈫?onSend callback fires 鈫?caller routes to
 * ConversationViewModel 鈫?SessionAgent.sendMessage via WebSocket.
 *
 * Streaming: setStreaming(true) shows STOP button, hides attach/mode,
 * keeps textarea writable for interjection while agent runs.
 */
export class InputPanel {
  readonly element: HTMLElement;
  private _textarea: HTMLTextAreaElement;
  private _sendBtn: HTMLButtonElement;
  private _stopBtn: HTMLButtonElement;
  private _attachBtn: HTMLButtonElement;
  private _modeSelector: ModeSelector;
  private _attachmentsBar: HTMLElement;
  private _goalCard: HTMLElement;
  private _slashPanel: SlashCommandPanel;
  private _commands: CommandDefinition[] = [];
  private _attachments: Attachment[] = [];
  private _goal: GoalState | null = null;
  private _goalExpanded = false;
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
      this._modeSelector.setGoal(this._goal as any);
      this._renderGoalCard();
    });

    // Load slash command definitions from API, wire selection to textarea insertion
    loadCommandsFromApi().then(cmds => { this._commands = cmds; }).catch(() => {});
    this._slashPanel.on('commandSelected', (name: string) => {
      this._insertCommand(name);
    });
  }

  // Build DOM: attachments bar (above) 鈫?textarea (mid) 鈫?button bar (below)
  private _build(): HTMLElement {
    const area = document.createElement('div');
    area.className = 'cinema-input-area';

    // Goal state and attachments (above textarea)
    area.appendChild(this._goalCard);
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

  // 鈹€鈹€ Textarea: auto-grows, Enter to send, arrow keys/Esc in slash popup 鈹€鈹€

  private _makeTextarea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.className = 'cinema-textarea';
    ta.placeholder = 'Continue...  (type / for commands)';
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
    // caused by DOM updates during streaming 鈥?the SlashCommandPanel's own
    // click-outside handler covers the case where the user clicks a non-focusable
    // element.
    ta.addEventListener('focusout', (e) => {
      const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (!related) return; // involuntary blur or click on non-focusable 鈥?let click handler decide
      // Focus moved within the input area 鈥?keep slash panel open
      if (this.element.contains(related)) return;
      // Focus moved to slash panel popup 鈥?keep it open (defensive; items aren't focusable today)
      if (this._slashPanel.containsElement(related)) return;
      // Genuine focus change to a focusable element elsewhere 鈥?close after a tick
      setTimeout(() => {
        if (this._slashPanel.isOpen) this._slashPanel.close();
      }, 150);
    });
    return ta;
  }

  // 鈹€鈹€ Slash command detection 鈹€鈹€

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

  // 鈹€鈹€ Attach button 鈥?uploads local files and sends them as attachments to the agent.
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

  // 鈹€鈹€ Attachments bar 鈹€鈹€

  private _makeAttachmentsBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'input-attachments-bar';
    return bar;
  }

  // Rebuild attachment chips DOM from _attachments array 鈥?each chip has icon, name, remove button
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
    this._goalCard.innerHTML = '';
    if (!this._goal || this._goal.status === 'deleted') {
      this._goalCard.classList.remove('visible', 'expanded', 'paused', 'active');
      this._goalExpanded = false;
      return;
    }

    const isActive = this._goal.status === 'active';
    this._goalCard.classList.add('visible');
    this._goalCard.classList.toggle('expanded', this._goalExpanded);
    this._goalCard.classList.toggle('active', isActive);
    this._goalCard.classList.toggle('paused', !isActive);

    const main = document.createElement('div');
    main.className = 'input-goal-card-main';

    const status = document.createElement('div');
    status.className = 'input-goal-status';
    const dot = document.createElement('span');
    dot.className = 'input-goal-dot';
    const statusText = document.createElement('span');
    statusText.textContent = isActive ? 'Goal active' : 'Goal paused';
    status.appendChild(dot);
    status.appendChild(statusText);

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'input-goal-summary';
    summary.textContent = this._goalSummary(this._goal.objective);
    summary.title = this._goal.objective;
    summary.addEventListener('click', () => {
      this._goalExpanded = !this._goalExpanded;
      this._renderGoalCard();
    });

    const actions = document.createElement('div');
    actions.className = 'input-goal-actions';
    const toggleBtn = this._makeGoalActionBtn(isActive ? 'Pause' : 'Resume', isActive ? 'pause' : 'resume');
    const editBtn = this._makeGoalActionBtn('Edit', 'edit');
    const deleteBtn = this._makeGoalActionBtn('Delete', 'delete');
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'cinema-tool-btn input-goal-action-btn';
    expandBtn.textContent = this._goalExpanded ? 'Less' : 'Details';
    expandBtn.title = this._goalExpanded ? 'Collapse goal details' : 'Show goal details';
    expandBtn.addEventListener('click', () => {
      this._goalExpanded = !this._goalExpanded;
      this._renderGoalCard();
    });
    actions.appendChild(toggleBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    actions.appendChild(expandBtn);

    main.appendChild(status);
    main.appendChild(summary);
    main.appendChild(actions);
    this._goalCard.appendChild(main);

    if (this._goalExpanded) {
      const detail = document.createElement('div');
      detail.className = 'input-goal-detail';
      detail.textContent = this._goal.objective;
      this._goalCard.appendChild(detail);

      const meta = document.createElement('div');
      meta.className = 'input-goal-meta';
      const updated = this._goal.updatedAt ? new Date(this._goal.updatedAt).toLocaleString() : '';
      const lastRun = this._goal.lastRunAt ? new Date(this._goal.lastRunAt).toLocaleString() : '';
      meta.textContent = [updated ? `Updated ${updated}` : '', lastRun ? `Last run ${lastRun}` : ''].filter(Boolean).join(' / ');
      if (meta.textContent) this._goalCard.appendChild(meta);
    }
  }

  private _makeGoalActionBtn(label: string, action: 'pause' | 'resume' | 'edit' | 'delete'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cinema-tool-btn input-goal-action-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      this._handleGoalAction(action).catch((err) => {
        ClientLogger.ui.error('Goal action failed', { error: (err as Error).message });
      });
    });
    return btn;
  }

  private async _handleGoalAction(action: 'start' | 'pause' | 'resume' | 'edit' | 'delete'): Promise<void> {
    const convVM = App.getInstance().conversationVM;
    if (action === 'start' || action === 'edit') {
      this._showGoalDialog(action, action === 'edit' ? this._goal?.objective || '' : '');
      return;
    }
    if (action === 'delete') {
      const ok = await ConfirmDialog.show('Delete this goal?', 'Delete Goal');
      if (!ok) return;
      this._goalExpanded = false;
    }
    convVM.setGoal(action);
  }

  private _showGoalDialog(action: 'start' | 'edit', initialObjective: string): void {
    const convVM = App.getInstance().conversationVM;
    const body = document.createElement('div');
    body.className = 'goal-dialog-body';

    const field = document.createElement('div');
    field.className = 'ui-form-field goal-dialog-field';
    const label = document.createElement('label');
    label.textContent = 'Goal objective';
    const textarea = document.createElement('textarea');
    textarea.className = 'ui-textarea goal-dialog-textarea';
    textarea.rows = 6;
    textarea.placeholder = 'Describe the outcome AnoClaw should keep working toward.';
    textarea.value = initialObjective;
    field.appendChild(label);
    field.appendChild(textarea);
    body.appendChild(field);

    const hint = document.createElement('div');
    hint.className = 'goal-dialog-hint';
    hint.textContent = 'Keep it specific enough that the agent can choose the next useful step.';
    body.appendChild(hint);

    const footer = document.createElement('div');
    footer.className = 'goal-dialog-actions';
    let dialog: Dialog | null = null;
    const cancelBtn = new Button({ label: 'Cancel', onClick: () => dialog?.close() });
    const submitBtn = new Button({
      label: action === 'edit' ? 'Change' : 'Start',
      variant: 'primary',
      onClick: () => {
        const objective = textarea.value.trim();
        if (!objective) return;
        convVM.setGoal(action, objective);
        this._goalExpanded = action === 'edit' ? this._goalExpanded : false;
        dialog?.close();
      },
    });
    submitBtn.disabled = !textarea.value.trim();
    textarea.addEventListener('input', () => {
      submitBtn.disabled = !textarea.value.trim();
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && textarea.value.trim()) {
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
      width: '520px',
    });
    dialog.show();
    setTimeout(() => textarea.focus(), 0);
  }

  private _goalSummary(objective: string): string {
    const oneLine = objective.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 120) return oneLine;
    return `${oneLine.slice(0, 117).trim()}...`;
  }

  // 鈹€鈹€ Send / Stop buttons 鈹€鈹€

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

  // 鈹€鈹€ Streaming state 鈹€鈹€

  // Toggle between send mode (attach+mode visible) and streaming mode (stop visible, input dimmed)
  setStreaming(v: boolean): void {
    this.isStreaming = v;
    // During streaming: keep textarea writable for soft interrupt, show send button
    this._sendBtn.style.display = '';          // always visible 鈥?user can interject
    this._stopBtn.style.display = v ? '' : 'none';
    this._attachBtn.style.display = v ? 'none' : '';
    this._modeSelector.element.style.display = v ? 'none' : '';
    // Subtle visual cue that agent is working, but keep input fully functional
    this._textarea.style.opacity = v ? '0.7' : '';
  }

  // 鈹€鈹€ Send 鈹€鈹€

  // Clear textarea and attachments, then fire onSend with content + mode + attachments
  private _fireSend(): void {
    let content = this._textarea.value.trim();
    if (!content) return;
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
      this.onSend(content, this._currentMode, attachments);
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
        this.onSend(INIT_PROTOCOL_PROMPT, this._currentMode, []);
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
}


