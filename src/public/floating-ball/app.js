// Floating Ball — satellite actions, distance-based hover
// Renders 6 satellite circles around the AnoClaw icon.
// - Hover detection uses mousemove distance from window center (100px threshold).
// - Satellites appear/disappear via body.hover class (CSS animations).
// - Click actions: new-session or open-session via IPC to main process.
//
// SATELLITES layout:
//   0: ✏️ 快速对话 (new session)
//   1-5: Most recent sessions (first char as avatar, truncated title as label)

const api = window.electronAPI;

const SATELLITES = [
  { label: '快速对话', icon: '✏️', action: 'new-session' },
  { label: '最近会话', icon: '', action: 'session', sessionIndex: 0 },
  { icon: '', action: 'session', sessionIndex: 1 },
  { icon: '', action: 'session', sessionIndex: 2 },
  { icon: '', action: 'session', sessionIndex: 3 },
  { icon: '', action: 'session', sessionIndex: 4 },
];

const ORBIT_RADIUS = 95;
const CENTER = { x: 200, y: 200 }; // center of 400x400 window
const HOVER_RADIUS = 100; // px from center to show satellites

function orbitalPosition(index, total) {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return {
    x: Math.round(Math.cos(angle) * ORBIT_RADIUS),
    y: Math.round(Math.sin(angle) * ORBIT_RADIUS),
  };
}

function renderSatellites(sessions) {
  const container = document.getElementById('satellites');
  container.innerHTML = '';

  SATELLITES.forEach((def, i) => {
    const pos = orbitalPosition(i, SATELLITES.length);
    const el = document.createElement('div');
    el.className = 'sat';
    el.style.setProperty('--ox', `${pos.x}px`);
    el.style.setProperty('--oy', `${pos.y}px`);
    el.style.setProperty('--delay', `${i * 0.07}s`);

    if (def.action === 'new-session') {
      el.textContent = '✏️';
      el.style.fontSize = '18px';
      el.title = def.label;
    } else {
      const session = sessions && sessions[i - 1];
      if (session) {
        el.textContent = session.title.charAt(0).toUpperCase() || '·';
        el.title = session.title;
      } else {
        el.textContent = '·';
        el.style.opacity = '0.25';
      }
      const label = document.createElement('div');
      label.className = 'sat-label';
      label.textContent = def.label || (session && session.title.length > 5 ? session.title.slice(0, 5) + '…' : (session?.title || ''));
      el.appendChild(label);
    }

    el.dataset.action = def.action;
    el.dataset.sessionIndex = String(def.sessionIndex ?? '');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAction(el);
    });
    container.appendChild(el);
  });
}

function handleAction(el) {
  const action = el.dataset.action;
  if (action === 'new-session') {
    api?.send('floating-ball-action', 'new-session');
  } else if (action === 'session') {
    const idx = parseInt(el.dataset.sessionIndex);
    api?.send('floating-ball-action', 'open-session', idx);
  }
}

// ─── Distance-based hover: measure mouse distance from window center ───
let hoverActive = false;

document.addEventListener('mousemove', (e) => {
  const dx = e.clientX - CENTER.x;
  const dy = e.clientY - CENTER.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const near = dist < HOVER_RADIUS;

  if (near === hoverActive) return;
  hoverActive = near;

  if (near) {
    document.body.classList.add('hover');
  } else {
    document.body.classList.remove('hover');
  }
});

async function init() {
  try {
    const sessions = await api?.invoke('floating-ball-sessions');
    renderSatellites(sessions || []);
  } catch {
    renderSatellites([]);
  }
}

init();
