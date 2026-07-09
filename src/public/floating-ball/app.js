// Floating Ball quick helper.
// Provides status, satellite shortcuts, quick ask, and clipboard text actions.

const api = window.electronAPI;

const CENTER = { x: 200, y: 200 };
const ORBIT_RADIUS = 100;
const HOVER_RADIUS = 105;
const CLIP_LIMIT = 4000;
const AUTO_CAPTURE_INTERVAL_MS = 850;

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke-width="2" stroke-linecap="round"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M9 6h9v9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 9 5-9 5V7Z" fill="currentColor"/></svg>',
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
  waitingInbox: null,
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

const els = {
  body: document.body,
  satellites: document.getElementById('satellites'),
  panel: document.getElementById('helperPanel'),
  panelClose: document.getElementById('panelClose'),
  ballButton: document.getElementById('ballButton'),
  helperTitle: document.getElementById('helperTitle'),
  statusPill: document.getElementById('statusPill'),
  statusDetail: document.getElementById('statusDetail'),
  quickInput: document.getElementById('quickInput'),
  quickSend: document.getElementById('quickSend'),
  clipRefresh: document.getElementById('clipRefresh'),
  clipPreview: document.getElementById('clipPreview'),
  clipTitle: document.querySelector('.clip-head span'),
  waitingCard: document.getElementById('waitingCard'),
  waitingTitle: document.getElementById('waitingTitle'),
  waitingDetail: document.getElementById('waitingDetail'),
  recentList: document.getElementById('recentList'),
};

function cleanText(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function phaseForState(state) {
  if (state.waitingCount > 0) return 'waiting';
  if (state.runningCount > 0) return 'running';
  if (state.connection === 'disconnected') return 'disconnected';
  if (state.currentTask?.phase === 'failed') return 'failed';
  if (state.currentTask?.phase === 'done') return 'done';
  return 'idle';
}

function phaseLabel(phase) {
  switch (phase) {
    case 'waiting': return 'Waiting';
    case 'running': return 'Running';
    case 'failed': return 'Failed';
    case 'done': return 'Done';
    case 'disconnected': return 'Offline';
    default: return 'Ready';
  }
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
  if (state.waitingCount > 0) {
    items.push({
      label: 'Waiting',
      icon: ICONS.wait,
      action: 'open-waiting',
      data: { sessionId: state.waitingInbox?.sessionId || state.currentTask?.sessionId || state.activeSessionId },
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
  const activeTitle = cleanText(currentState.activeTitle || task.title || 'Ready', 42);
  const clipboardText = cleanText(currentState.clipboardText || '', CLIP_LIMIT);
  const selectionCaptured = Boolean(clipboardText && capturedClipboardText && clipboardText === capturedClipboardText);

  els.body.dataset.phase = phase;
  els.body.classList.toggle('selection-captured', selectionCaptured);
  els.helperTitle.textContent = activeTitle;
  els.statusPill.textContent = phaseLabel(phase);
  els.statusDetail.textContent = selectionCaptured
    ? 'Selected text copied. Choose an action below.'
    : waiting
      ? cleanText(waiting.title || task.detail || `${currentState.waitingCount} waiting`, 70)
    : cleanText(task.detail || `${currentState.runningCount} running, ${currentState.waitingCount} waiting`, 70);
  renderWaitingCard(waiting);
  els.clipPreview.textContent = clipboardText
    ? clipboardText.slice(0, 190) + (clipboardText.length > 190 ? '...' : '')
    : 'Copy selected text to unlock actions.';
  els.panel.classList.toggle('has-clip', Boolean(clipboardText));
  els.panel.classList.toggle('has-waiting', Boolean(waiting && currentState.waitingCount > 0));
  els.panel.classList.toggle('has-activity', Array.isArray(currentState.activityItems) && currentState.activityItems.length > 0);
  els.panel.classList.toggle('is-selection-captured', selectionCaptured);
  if (els.clipTitle) els.clipTitle.textContent = selectionCaptured ? 'Selection captured' : 'Clipboard text';
  els.quickInput.placeholder = clipboardText ? 'Ask about selected text...' : 'Ask quickly...';

  renderActivityOrRecent();
}

function renderWaitingCard(waiting) {
  if (!els.waitingCard) return;
  const hasWaiting = Boolean(waiting && currentState.waitingCount > 0);
  els.waitingCard.classList.toggle('is-visible', hasWaiting);
  els.waitingCard.disabled = !hasWaiting;
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
  sendAction('quick-ask', { question });
  els.quickInput.value = '';
}

function sendTextAction(kind) {
  const text = String(currentState.clipboardText || '').trim().slice(0, CLIP_LIMIT);
  if (!text) {
    els.clipPreview.textContent = 'Copy text first, then refresh.';
    return;
  }
  sendAction('text-action', {
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
els.clipRefresh?.addEventListener('click', refreshState);
els.waitingCard?.addEventListener('click', () => {
  const waiting = currentState.waitingInbox || {};
  sendAction('open-waiting', { sessionId: waiting.sessionId || currentState.currentTask?.sessionId || currentState.activeSessionId });
});

document.querySelectorAll('[data-helper-action]').forEach((button) => {
  button.addEventListener('click', () => sendAction(button.dataset.helperAction));
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
