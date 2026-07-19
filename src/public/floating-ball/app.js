// Floating Ball quick helper.
// Provides status, satellite shortcuts, quick ask, and clipboard text actions.

const api = window.electronAPI;

const CENTER = { x: 200, y: 200 };
const ORBIT_RADIUS = 112;
const HOVER_RADIUS = 120;
const CLIP_LIMIT = 4000;
const AUTO_CAPTURE_INTERVAL_MS = 850;
const NOTICE_TTL_MS = 8000;

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke-width="2" stroke-linecap="round"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M9 6h9v9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 9 5-9 5V7Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" fill="none" stroke-width="2.4" stroke-linecap="round"/></svg>',
  goal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v3M12 17v3M4 12h3M17 12h3" fill="none" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="5" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>',
  wait: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6l4 2M5 4h14M5 20h14" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
};

const DEFAULT_STATE = {
  activeSessionId: null,
  activeTitle: null,
  connection: 'disconnected',
  runningCount: 0,
  waitingCount: 0,
  recentSessions: [],
  activityItems: [],
  helperNotice: null,
  waitingInbox: null,
  goalPulse: null,
  currentTask: null,
  clipboardText: '',
};

let currentState = { ...DEFAULT_STATE };
let hoverActive = false;
let panelOpen = false;
let statePoll = null;
let baselineClipboard = null;
let lastClipboardText = '';
let capturedClipboardText = '';
let capturePulseTimer = null;
let noticeTimer = null;
let selectedTargetSessionId = '';
let targetOptionsSignature = '';

const els = {
  body: document.body,
  satellites: document.getElementById('satellites'),
  panel: document.getElementById('helperPanel'),
  panelClose: document.getElementById('panelClose'),
  ballButton: document.getElementById('ballButton'),
  ballStatus: document.getElementById('ballStatus'),
  helperTitle: document.getElementById('helperTitle'),
  statusPill: document.getElementById('statusPill'),
  statusDetail: document.getElementById('statusDetail'),
  goalCard: document.getElementById('goalCard'),
  goalBadge: document.getElementById('goalBadge'),
  goalTitle: document.getElementById('goalTitle'),
  goalDetail: document.getElementById('goalDetail'),
  goalToggle: document.getElementById('goalToggle'),
  goalOpen: document.getElementById('goalOpen'),
  quickTarget: document.getElementById('quickTarget'),
  quickInput: document.getElementById('quickInput'),
  quickSend: document.getElementById('quickSend'),
  clipRefresh: document.getElementById('clipRefresh'),
  clipPreview: document.getElementById('clipPreview'),
  clipTitle: document.querySelector('.clip-head span'),
  waitingCard: document.getElementById('waitingCard'),
  waitingOpen: document.getElementById('waitingOpen'),
  waitingApprove: document.getElementById('waitingApprove'),
  waitingReject: document.getElementById('waitingReject'),
  waitingTitle: document.getElementById('waitingTitle'),
  waitingDetail: document.getElementById('waitingDetail'),
  recentList: document.getElementById('recentList'),
};

function cleanText(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function currentGoal(state = currentState) {
  const goal = state.goalPulse || null;
  if (!goal || goal.status === 'deleted') return null;
  if (!cleanText(goal.objective, 1) && !goal.sessionId) return null;
  return goal;
}

function phaseForState(state) {
  const goal = currentGoal(state);
  if (state.waitingCount > 0 || ['blocked', 'waiting_user', 'waiting_confirmation', 'waiting_review'].includes(goal?.status)) return 'waiting';
  if (state.connection === 'disconnected') return 'disconnected';
  if (goal?.status === 'active') return 'goal';
  if (state.runningCount > 0) return 'running';
  if (goal?.status === 'paused') return 'paused';
  if (goal?.status === 'completed') return 'done';
  if (goal?.status === 'failed' || goal?.status === 'budget_exhausted') return 'failed';
  if (state.currentTask?.phase === 'failed') return 'failed';
  if (state.currentTask?.phase === 'done') return 'done';
  return 'idle';
}

function phaseLabel(phase) {
  switch (phase) {
    case 'waiting': return 'Waiting';
    case 'running': return 'Running';
    case 'goal': return 'Goal';
    case 'paused': return 'Paused';
    case 'failed': return 'Failed';
    case 'done': return 'Done';
    case 'disconnected': return 'Offline';
    default: return 'Ready';
  }
}

function goalBadgeText(status) {
  switch (status) {
    case 'blocked': return 'Waiting';
    case 'waiting_user': return 'Input';
    case 'waiting_confirmation': return 'Approve';
    case 'waiting_review': return 'Review';
    case 'budget_exhausted': return 'Limit';
    case 'failed': return 'Failed';
    case 'paused': return 'Paused';
    case 'completed': return 'Done';
    case 'active':
    default: return 'Goal';
  }
}

function statusCount(value) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

function ballStatusForState(state, phase) {
  const goal = currentGoal(state);
  if (state.waitingCount > 0 || ['blocked', 'waiting_user', 'waiting_confirmation', 'waiting_review'].includes(goal?.status)) {
    const count = statusCount(state.waitingCount || 1);
    return { text: count, kind: 'waiting', label: `${count} waiting` };
  }
  if (state.runningCount > 0) {
    const count = statusCount(state.runningCount);
    return { text: count, kind: 'running', label: `${count} running` };
  }
  if (goal?.status === 'active') return { text: 'G', kind: 'goal', label: 'Goal active' };
  if (goal?.status === 'paused') return { text: 'II', kind: 'paused', label: 'Goal paused' };
  if (goal?.status === 'failed' || goal?.status === 'budget_exhausted') return { text: '!', kind: 'failed', label: 'Goal stopped' };
  if (goal?.status === 'completed') return { text: 'OK', kind: 'done', label: 'Goal completed' };
  if (phase === 'failed') return { text: '!', kind: 'failed', label: 'Recent task failed' };
  if (phase === 'disconnected') return { text: '!', kind: 'failed', label: 'AnoClaw offline' };
  if (phase === 'done') return { text: 'OK', kind: 'done', label: 'Recent task completed' };
  return { text: '', kind: 'idle', label: 'AnoClaw ready' };
}

function freshNotice() {
  const notice = currentState.helperNotice;
  if (!notice?.text || !notice.timestamp) return null;
  return Date.now() - Number(notice.timestamp) < NOTICE_TTL_MS ? notice : null;
}

function orbitalPosition(index, total) {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return {
    x: Math.round(Math.cos(angle) * ORBIT_RADIUS),
    y: Math.round(Math.sin(angle) * ORBIT_RADIUS),
  };
}

function buildSatellites(state) {
  const items = [];
  const goal = currentGoal(state);
  if (state.waitingCount > 0) {
    items.push({
      label: 'Waiting',
      icon: ICONS.wait,
      action: 'open-waiting',
      data: { sessionId: state.waitingInbox?.sessionId || state.currentTask?.sessionId || state.activeSessionId },
    });
  }
  if (goal) {
    items.push({
      label: goal.status === 'paused' ? 'Goal Paused' : 'Goal',
      icon: goal.status === 'paused' ? ICONS.pause : ICONS.goal,
      action: 'open-goal',
      data: { sessionId: goal.sessionId },
    });
  }
  items.push({ label: 'Continue', icon: ICONS.play, action: 'continue-current' });
  items.push({ label: 'New', icon: ICONS.plus, action: 'new-session' });
  if (state.runningCount > 0) {
    items.push({ label: 'Stop', icon: ICONS.stop, action: 'stop-current', data: { sessionId: state.currentTask?.sessionId || state.activeSessionId } });
  }
  for (const session of state.recentSessions || []) {
    if (items.length >= 6) break;
    items.push({
      label: cleanText(session.title, 12) || 'Session',
      text: cleanText(session.title, 1).toUpperCase() || 'S',
      action: 'open-session',
      data: { sessionId: session.id },
    });
  }
  while (items.length < 4) items.push({ label: 'Open', icon: ICONS.open, action: 'open-current' });
  return items.slice(0, 6);
}

function renderSatellites() {
  const items = buildSatellites(currentState);
  els.satellites.innerHTML = '';
  items.forEach((item, index) => {
    const pos = orbitalPosition(index, items.length);
    const button = document.createElement('button');
    button.className = 'sat';
    button.type = 'button';
    button.title = item.label;
    button.style.setProperty('--ox', `${pos.x}px`);
    button.style.setProperty('--oy', `${pos.y}px`);
    button.style.setProperty('--delay', `${index * 0.05}s`);
    if (item.icon) button.innerHTML = item.icon;
    else button.textContent = item.text || 'S';
    const label = document.createElement('span');
    label.className = 'sat-label';
    label.textContent = item.label;
    button.appendChild(label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      sendAction(item.action, item.data || {});
    });
    els.satellites.appendChild(button);
  });
}

function renderPanel() {
  const phase = phaseForState(currentState);
  const task = currentState.currentTask || {};
  const waiting = currentState.waitingInbox || null;
  const notice = freshNotice();
  const goal = currentGoal(currentState);
  const activeTitle = cleanText(currentState.activeTitle || task.title || 'Ready', 42);
  const clipboardText = cleanText(currentState.clipboardText || '', CLIP_LIMIT);
  const selectionCaptured = Boolean(clipboardText && capturedClipboardText && clipboardText === capturedClipboardText);

  els.body.dataset.phase = phase;
  els.body.dataset.noticeKind = notice?.kind || '';
  els.body.classList.toggle('selection-captured', selectionCaptured);
  renderBallStatus(phase);
  els.helperTitle.textContent = activeTitle;
  els.statusPill.textContent = notice
    ? notice.kind === 'error' ? 'Error' : notice.kind === 'success' ? 'Sent' : 'Info'
    : phaseLabel(phase);
  els.statusDetail.textContent = notice
    ? cleanText(notice.text, 76)
    : selectionCaptured
    ? 'Selected text copied. Choose an action below.'
    : waiting
      ? cleanText(waiting.title || task.detail || `${currentState.waitingCount} waiting`, 70)
    : goal
      ? cleanText(goal.objective || task.detail || 'Goal active', 70)
    : cleanText(task.detail || `${currentState.runningCount} running, ${currentState.waitingCount} waiting`, 70);
  renderGoalCard(goal);
  renderTargetPicker();
  renderWaitingCard(waiting);
  els.clipPreview.textContent = clipboardText
    ? clipboardText.slice(0, 190) + (clipboardText.length > 190 ? '...' : '')
    : 'Copy selected text to unlock actions.';
  els.panel.classList.toggle('has-clip', Boolean(clipboardText));
  els.panel.classList.toggle('has-waiting', Boolean(waiting && currentState.waitingCount > 0));
  els.panel.classList.toggle('has-goal', Boolean(goal));
  els.panel.classList.toggle('has-activity', Array.isArray(currentState.activityItems) && currentState.activityItems.length > 0);
  els.panel.classList.toggle('is-selection-captured', selectionCaptured);
  if (els.clipTitle) els.clipTitle.textContent = selectionCaptured ? 'Selection captured' : 'Clipboard text';
  els.quickInput.placeholder = selectionCaptured ? 'Ask about selected text...' : 'Ask quickly...';

  renderActivityOrRecent();
  scheduleNoticeExpiry(notice);
}

function renderBallStatus(phase) {
  if (!els.ballStatus) return;
  const status = ballStatusForState(currentState, phase);
  els.ballStatus.textContent = status.text;
  els.ballStatus.dataset.kind = status.kind;
  els.ballStatus.classList.toggle('is-visible', Boolean(status.text));
  const title = `${status.label}. Click to open AnoClaw helper.`;
  els.ballButton.title = title;
  els.ballButton.setAttribute('aria-label', title);
}

function scheduleNoticeExpiry(notice) {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (!notice?.timestamp) return;
  const remaining = NOTICE_TTL_MS - (Date.now() - Number(notice.timestamp));
  if (remaining > 0) noticeTimer = setTimeout(renderPanel, remaining + 60);
}

function renderGoalCard(goal) {
  if (!els.goalCard) return;
  const visible = Boolean(goal);
  els.goalCard.classList.toggle('is-visible', visible);
  els.goalCard.dataset.status = goal?.status || '';
  if (!visible) {
    els.goalBadge.textContent = 'Goal';
    els.goalTitle.textContent = 'No goal';
    els.goalDetail.textContent = 'Ready';
    els.goalToggle.disabled = true;
    return;
  }

  const status = goal.status || 'active';
  const isPaused = status === 'paused';
  const resumable = ['paused', 'blocked', 'failed'].includes(status);
  const pausable = ['active', 'waiting_user', 'waiting_confirmation'].includes(status);
  const canToggle = resumable || pausable;
  const objective = cleanText(goal.objective || 'Active goal', 90);
  const meta = [
    `Runs ${goal.runCount || 0}/${goal.maxRuns || 20}`,
    typeof goal.progress === 'number' ? `${goal.progress}%` : '',
    cleanText(goal.lastSummary || goal.statusReason, 70),
  ].filter(Boolean).join(' · ');

  els.goalBadge.textContent = goalBadgeText(status);
  els.goalTitle.textContent = objective;
  els.goalTitle.title = goal.objective || objective;
  els.goalDetail.textContent = meta || (isPaused ? 'Paused from FloatingBall' : 'Visible while AnoClaw is minimized');
  els.goalToggle.textContent = status === 'waiting_review'
    ? 'Review in app'
    : status === 'budget_exhausted'
      ? 'Edit in app'
      : status === 'completed'
        ? 'Completed'
        : resumable ? 'Resume' : 'Pause';
  els.goalToggle.disabled = !canToggle;
}

function targetChoices() {
  const choices = [];
  const seen = new Set();
  const add = (id, label, prefix) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    choices.push({ id, label: `${prefix}: ${cleanText(label || 'Session', 44)}` });
  };
  const goal = currentGoal(currentState);
  add(currentState.waitingInbox?.sessionId, currentState.waitingInbox?.title || currentState.currentTask?.title, 'Waiting');
  add(goal?.sessionId, goal?.objective || currentState.activeTitle, 'Goal');
  add(currentState.activeSessionId, currentState.activeTitle, 'Active');
  add(currentState.currentTask?.sessionId, currentState.currentTask?.title, 'Task');
  (currentState.recentSessions || []).slice(0, 5).forEach((session) => add(session.id, session.title, 'Recent'));
  return choices;
}

function renderTargetPicker() {
  if (!els.quickTarget) return;
  const choices = targetChoices();
  const previous = selectedTargetSessionId || els.quickTarget.value || '';
  const fallback = choices[0]?.id || '';
  const nextValue = choices.some((choice) => choice.id === previous) ? previous : fallback;
  selectedTargetSessionId = nextValue;
  const signature = choices.map((choice) => `${choice.id}:${choice.label}`).join('|');
  if (!choices.length) {
    if (targetOptionsSignature !== 'empty') {
      els.quickTarget.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Auto: first session';
      els.quickTarget.appendChild(option);
      targetOptionsSignature = 'empty';
    }
    els.quickTarget.disabled = true;
    return;
  }
  els.quickTarget.disabled = false;
  if (targetOptionsSignature !== signature) {
    els.quickTarget.innerHTML = '';
    choices.forEach((choice) => {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = choice.label;
      option.title = choice.label;
      els.quickTarget.appendChild(option);
    });
    targetOptionsSignature = signature;
  }
  els.quickTarget.value = nextValue;
}

function selectedTargetPayload(extra = {}) {
  const sessionId = els.quickTarget?.value || selectedTargetSessionId || targetChoices()[0]?.id || '';
  return sessionId ? { ...extra, sessionId } : { ...extra };
}

function renderWaitingCard(waiting) {
  if (!els.waitingCard) return;
  const hasWaiting = Boolean(waiting && currentState.waitingCount > 0);
  els.waitingCard.classList.toggle('is-visible', hasWaiting);
  els.waitingCard.classList.toggle('can-inline', Boolean(hasWaiting && waiting?.canInlineResolve));
  els.waitingOpen.disabled = !hasWaiting;
  els.waitingApprove.disabled = !hasWaiting || !waiting?.canInlineResolve;
  els.waitingReject.disabled = !hasWaiting || !waiting?.canInlineResolve;
  if (!hasWaiting) {
    els.waitingTitle.textContent = 'Needs attention';
    els.waitingDetail.textContent = 'Open AnoClaw to review.';
    return;
  }
  const risk = cleanText(waiting.riskLevel || '', 18);
  const title = cleanText(waiting.title || 'Needs attention', 54);
  const detail = cleanText(waiting.detail || 'Open AnoClaw to review the waiting item.', 82);
  els.waitingTitle.textContent = currentState.waitingCount > 1
    ? `${title} +${currentState.waitingCount - 1}`
    : title;
  els.waitingDetail.textContent = risk ? `${risk} · ${detail}` : detail;
}

function waitingPayload(extra = {}) {
  const waiting = currentState.waitingInbox || {};
  return {
    ...extra,
    toolCallId: waiting.toolCallId,
    sessionId: waiting.sessionId || currentState.currentTask?.sessionId || currentState.activeSessionId,
  };
}

function render() {
  renderPanel();
  renderSatellites();
}

function renderActivityOrRecent() {
  const activities = Array.isArray(currentState.activityItems) ? currentState.activityItems.slice(0, 3) : [];
  els.recentList.innerHTML = '';
  els.recentList.classList.toggle('activity-list', activities.length > 0);
  if (activities.length > 0) {
    activities.forEach((activity) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `recent-item activity-item activity-${activity.status === 'failed' ? 'failed' : 'completed'}`;
      row.title = `${cleanText(activity.title, 80)}${activity.detail ? ` · ${cleanText(activity.detail, 100)}` : ''}`;
      row.innerHTML = '<span class="recent-dot"></span><span class="recent-title"></span>';
      row.querySelector('.recent-title').textContent = cleanText(activity.detail || activity.title, 34) || 'Activity';
      row.addEventListener('click', () => sendAction('open-session', { sessionId: activity.sessionId || currentState.activeSessionId }));
      els.recentList.appendChild(row);
    });
    return;
  }

  els.recentList.classList.remove('activity-list');
  (currentState.recentSessions || []).slice(0, 3).forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'recent-item';
    row.innerHTML = '<span class="recent-dot"></span><span class="recent-title"></span>';
    row.querySelector('.recent-title').textContent = cleanText(session.title, 30) || 'Session';
    row.addEventListener('click', () => sendAction('open-session', { sessionId: session.id }));
    els.recentList.appendChild(row);
  });
}

async function refreshState() {
  try {
    const next = await api?.floatingBallGetState?.();
    currentState = { ...DEFAULT_STATE, ...(next || {}) };
    detectClipboardCapture(currentState.clipboardText || '');
    render();
  } catch {
    currentState = { ...currentState, connection: 'disconnected' };
    render();
  }
}

function detectClipboardCapture(rawText) {
  const text = String(rawText || '').trim().slice(0, CLIP_LIMIT);
  if (baselineClipboard === null) {
    baselineClipboard = text;
    lastClipboardText = text;
    return;
  }
  if (!text || text === lastClipboardText) return;
  lastClipboardText = text;
  if (text === baselineClipboard) return;
  showSelectionCapture(text);
}

function sendAction(action, data) {
  api?.floatingBallAction?.(action, data || {});
}

function sendQuickAsk() {
  const question = cleanText(els.quickInput.value, 1000);
  if (!question) return;
  sendAction('quick-ask', selectedTargetPayload({ question }));
  els.quickInput.value = '';
}

function sendTextAction(kind) {
  const text = String(currentState.clipboardText || '').trim().slice(0, CLIP_LIMIT);
  if (!text) {
    els.clipPreview.textContent = 'Copy text first, then refresh.';
    return;
  }
  sendAction('text-action', {
    ...selectedTargetPayload(),
    kind,
    text,
    question: cleanText(els.quickInput.value, 600),
  });
  clearSelectionCapture(false);
}

function setHoverActive(active) {
  if (panelOpen) active = false;
  if (active === hoverActive) return;
  hoverActive = active;
  els.body.classList.toggle('hover', active);
}

function showSelectionCapture(text) {
  capturedClipboardText = text;
  els.body.classList.add('selection-captured');
  els.body.classList.add('capture-pulse');
  if (capturePulseTimer) clearTimeout(capturePulseTimer);
  capturePulseTimer = setTimeout(() => {
    els.body.classList.remove('capture-pulse');
    capturePulseTimer = null;
  }, 4200);
  setPanelOpen(true, { focusInput: false });
}

function clearSelectionCapture(renderAfter = true) {
  capturedClipboardText = '';
  els.body.classList.remove('selection-captured', 'capture-pulse');
  if (capturePulseTimer) {
    clearTimeout(capturePulseTimer);
    capturePulseTimer = null;
  }
  if (renderAfter) renderPanel();
}

function setPanelOpen(open, options = {}) {
  panelOpen = open;
  els.body.classList.toggle('panel-open', open);
  setHoverActive(false);
  if (!open) clearSelectionCapture(false);
  if (open) {
    refreshState();
    if (options.focusInput !== false) els.quickInput.focus();
  }
}

function startStatePolling() {
  if (statePoll) return;
  statePoll = setInterval(refreshState, AUTO_CAPTURE_INTERVAL_MS);
}

document.addEventListener('mousemove', (event) => {
  const dx = event.clientX - CENTER.x;
  const dy = event.clientY - CENTER.y;
  setHoverActive(Math.sqrt(dx * dx + dy * dy) < HOVER_RADIUS);
});

document.addEventListener('mouseleave', () => setHoverActive(false));

els.ballButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  setPanelOpen(!panelOpen, { focusInput: !panelOpen });
});

els.ballButton?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setPanelOpen(true, { focusInput: true });
});

els.panelClose?.addEventListener('click', () => setPanelOpen(false));
els.panel?.addEventListener('click', (event) => event.stopPropagation());
els.quickSend?.addEventListener('click', sendQuickAsk);
els.quickInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendQuickAsk();
});
els.quickTarget?.addEventListener('change', () => {
  selectedTargetSessionId = els.quickTarget.value || '';
});
els.clipRefresh?.addEventListener('click', refreshState);
els.waitingOpen?.addEventListener('click', () => sendAction('open-waiting', waitingPayload()));
els.waitingApprove?.addEventListener('click', () => sendAction('waiting-resolve', waitingPayload({ approved: true })));
els.waitingReject?.addEventListener('click', () => sendAction('waiting-resolve', waitingPayload({ approved: false })));
els.goalToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  const goal = currentGoal(currentState);
  if (!goal) return;
  sendAction('goal-toggle', { sessionId: goal.sessionId, status: goal.status });
});
els.goalOpen?.addEventListener('click', (event) => {
  event.stopPropagation();
  const goal = currentGoal(currentState);
  sendAction('open-goal', { sessionId: goal?.sessionId || currentState.activeSessionId });
});

document.querySelectorAll('[data-helper-action]').forEach((button) => {
  button.addEventListener('click', () => sendAction(button.dataset.helperAction, selectedTargetPayload()));
});

document.querySelectorAll('[data-text-action]').forEach((button) => {
  button.addEventListener('click', () => sendTextAction(button.dataset.textAction));
});

api?.onFloatingBallStateChanged?.((state) => {
  currentState = { ...DEFAULT_STATE, ...(state || {}) };
  detectClipboardCapture(currentState.clipboardText || '');
  render();
});

refreshState();
startStatePolling();
