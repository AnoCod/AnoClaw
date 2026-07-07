// MeetingTable.ts - Interactive oval meeting table visualization
// Displays participants as avatar seats positioned around an elliptical table.
// Dynamically resizes based on participant count. Shows speaking indicators,
// turn rings, observer positioning, join/leave animations.

interface MeetingParticipant {
  id: string;
  name: string;
  role?: 'moderator' | 'speaker' | 'observer';
}

interface TranscriptEntry {
  speaker?: string;
  speakerName?: string;
  speakerId?: string;
  content?: string;
  round?: number;
}

interface MeetingTableData {
  id: string;
  topic?: string;
  participants: MeetingParticipant[];
  transcript: TranscriptEntry[];
  currentRound?: number;
  maxRounds?: number;
  status?: string;
  participantRoles?: Record<string, string>;
}

interface MeetingTableOptions {
  showTable?: boolean;
  onParticipantClick?: (participant: MeetingParticipant) => void;
}

// Deterministic color palette (matches existing AVATAR_COLORS)
const TABLE_COLORS = [
  '#57c1ff', '#59d499', '#ffc533', '#ff6161',
  '#9c9c9d', '#cdcdcd', '#6a6b6c', '#434345',
];

function deterministicColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  return TABLE_COLORS[Math.abs(h) % TABLE_COLORS.length];
}

function getInitials(name: string): string {
  if (!name) return '?';
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.charAt(0).toUpperCase();
}

function getTableDimensions(count: number): { width: number; height: number } {
  if (count <= 4) return { width: 280, height: 160 };
  if (count <= 8) return { width: 360, height: 200 };
  if (count <= 12) return { width: 440, height: 240 };
  return { width: 520, height: 280 };
}

export class MeetingTable {
  private container: HTMLElement;
  private data: MeetingTableData;
  private options: MeetingTableOptions;
  private wrapper: HTMLElement | null = null;
  private seatElements: Map<string, HTMLElement> = new Map();
  private currentSpeakingId: string | null = null;
  private _visible: boolean = true;

  constructor(container: HTMLElement, data: MeetingTableData, options: MeetingTableOptions = {}) {
    this.container = container;
    this.data = data;
    this.options = options;
  }

  /** Get/set visibility */
  get visible(): boolean { return this._visible; }
  set visible(v: boolean) { this._visible = v; if (this.wrapper) this.wrapper.style.display = v ? '' : 'none'; }

  /** Full render of the table into the container */
  render(): void {
    this.container.innerHTML = '';
    if (!this.data.participants || this.data.participants.length === 0) {
      this.container.innerHTML = '<div style="text-align:center;padding:24px;font-size:11px;color:var(--c-text-quaternary);">No participants</div>';
      return;
    }

    const count = this.data.participants.length;
    const dims = getTableDimensions(count);
    const seatRadius = 48;
    // Ellipse radii for seat positioning (larger than table to place seats around it)
    const rx = dims.width / 2 + seatRadius + 16;
    const ry = dims.height / 2 + seatRadius + 16;
    // Total container size
    const totalW = (rx + seatRadius) * 2 + 32;
    const totalH = (ry + seatRadius) * 2 + 32;
    const cx = totalW / 2;
    const cy = totalH / 2;

    // Determine speaking ID from transcript
    const lastEntry = this.data.transcript && this.data.transcript.length > 0
      ? this.data.transcript[this.data.transcript.length - 1]
      : null;
    this.currentSpeakingId = lastEntry
      ? (lastEntry.speakerId || lastEntry.speaker || lastEntry.speakerName || null)
      : null;

    // Build wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'meeting-table-wrapper';
    wrapper.style.cssText = `width:${totalW}px;max-width:100%;margin:0 auto;position:relative;overflow:visible;`;
    this.wrapper = wrapper;

    // Table surface (ellipse)
    const tableEl = document.createElement('div');
    tableEl.className = 'meeting-table-surface';
    tableEl.style.cssText = `
      width:${dims.width}px;height:${dims.height}px;
      position:absolute;left:${cx - dims.width / 2}px;top:${cy - dims.height / 2}px;
      border-radius:50%;
      background:#121212;border:1px solid #242728;
      display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:4px;
      transition:width 0.3s ease,height 0.3s ease;
    `;
    // Center label
    const titleLabel = document.createElement('div');
    titleLabel.className = 'meeting-table-title';
    titleLabel.style.cssText = 'font-size:10px;font-weight:500;color:rgba(255,255,255,0.5);letter-spacing:0.5px;text-align:center;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleLabel.textContent = this.data.topic || 'Meeting';
    tableEl.appendChild(titleLabel);

    const countLabel = document.createElement('div');
    countLabel.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.25);letter-spacing:0.5px;';
    countLabel.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
    tableEl.appendChild(countLabel);

    wrapper.appendChild(tableEl);

    // Seats
    for (let i = 0; i < count; i++) {
      const p = this.data.participants[i];
      const angle = (2 * Math.PI * i) / count - Math.PI / 2; // Start from top
      const isObserver = p.role === 'observer';
      const observerOffset = isObserver ? 30 : 0;
      const seatX = cx + (rx + observerOffset) * Math.cos(angle);
      const seatY = cy + (ry + observerOffset) * Math.sin(angle);

      const color = deterministicColor(p.name || p.id);
      const initials = getInitials(p.name || p.id);

      // Check if this participant is currently speaking
      const isSpeaking = this.currentSpeakingId &&
        (this.currentSpeakingId === p.id || this.currentSpeakingId === p.name);

      // Check if this participant spoke in current round (turn indicator)
      const currentRound = this.data.currentRound || 1;
      const currentRoundEntries = (this.data.transcript || []).filter(
        (e: TranscriptEntry) => {
          const sid = e.speakerId || e.speaker;
          return e.round === currentRound && (sid === p.id || sid === p.name);
        }
      );
      const spokeInRound = currentRoundEntries.length > 0;

      const seat = document.createElement('div');
      seat.className = 'meeting-table-seat' + (isObserver ? ' observer' : '');
      seat.dataset.participantId = p.id;

      const borderStyle = isSpeaking
        ? `3px solid #59d499`
        : spokeInRound
          ? `3px solid #57c1ff`
          : `2px solid ${color}`;
      const opacity = isObserver ? '0.6' : '1';

      seat.style.cssText = `
        position:absolute;
        left:${seatX - seatRadius / 2}px;
        top:${seatY - seatRadius / 2}px;
        width:${seatRadius}px;height:${seatRadius}px;
        border-radius:50%;
        background:#0d0d0d;
        border:${borderStyle};
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;
        transition:transform 0.2s ease,border-color 0.2s ease;
        opacity:${opacity};
        z-index:2;
      `;

      // Initials text
      const initialsEl = document.createElement('span');
      initialsEl.style.cssText = `font-size:14px;font-weight:600;color:${color};pointer-events:none;`;
      initialsEl.textContent = initials;
      seat.appendChild(initialsEl);

      // Role icon overlay
      if (p.role === 'moderator') {
        const roleIcon = document.createElement('span');
        roleIcon.style.cssText = 'position:absolute;top:-4px;right:-4px;font-size:9px;pointer-events:none;background:var(--c-accent);color:#fff;border-radius:3px;padding:1px 3px;';
        roleIcon.textContent = 'M';
        seat.appendChild(roleIcon);
      } else if (p.role === 'observer' || (this.data.participantRoles && this.data.participantRoles[p.id] === 'observer')) {
        const roleIcon = document.createElement('span');
        roleIcon.style.cssText = 'position:absolute;top:-4px;right:-4px;font-size:9px;pointer-events:none;background:var(--c-surface-elevated);color:var(--c-text-tertiary);border-radius:3px;padding:1px 3px;';
        roleIcon.textContent = 'O';
        seat.appendChild(roleIcon);
      }

      // Speaking pulse animation
      if (isSpeaking) {
        const pulseRing = document.createElement('div');
        pulseRing.className = 'meeting-table-pulse-ring';
        pulseRing.style.cssText = `
          position:absolute;inset:-4px;border-radius:50%;
          border:2px solid rgba(89,212,153,0.4);
          animation:meetingTablePulse 2s ease-in-out infinite;
          pointer-events:none;
        `;
        seat.appendChild(pulseRing);
      }

      // Turn indicator ring
      if (spokeInRound && !isSpeaking) {
        const turnRing = document.createElement('div');
        turnRing.style.cssText = `
          position:absolute;inset:-3px;border-radius:50%;
          border:2px solid rgba(87,193,255,0.5);
          animation:meetingTableTurnPulse 3s ease-in-out infinite;
          pointer-events:none;
        `;
        seat.appendChild(turnRing);
      }

      // Tooltip on hover
      const tooltip = document.createElement('div');
      tooltip.className = 'meeting-table-tooltip';
      tooltip.style.cssText = `
        position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
        padding:4px 8px;background:#1a1a1a;border:1px solid #242728;border-radius:4px;
        font-size:9px;color:rgba(255,255,255,0.8);white-space:nowrap;pointer-events:none;
        opacity:0;transition:opacity 0.15s;z-index:10;
        display:flex;align-items:center;gap:4px;
      `;
      const roleTag = p.role ? `<span style="font-size:7px;color:rgba(255,255,255,0.4);text-transform:uppercase;">${p.role}</span>` : '';
      tooltip.innerHTML = `<span style="color:${color};font-weight:500;">${p.name || p.id}</span>${roleTag}`;
      seat.appendChild(tooltip);

      // Hover events
      seat.addEventListener('mouseenter', () => {
        seat.style.transform = 'scale(1.15)';
        tooltip.style.opacity = '1';
      });
      seat.addEventListener('mouseleave', () => {
        seat.style.transform = 'scale(1)';
        tooltip.style.opacity = '0';
      });

      // Click event
      seat.addEventListener('click', () => {
        if (this.options.onParticipantClick) {
          this.options.onParticipantClick(p);
        }
      });

      // Join animation
      seat.style.animation = `meetingTableSeatIn 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.05}s both`;

      this.seatElements.set(p.id, seat);
      wrapper.appendChild(seat);
    }

    this.container.appendChild(wrapper);
    this._visible = true;
  }

  /** Update speaking indicators and round info without full re-render */
  update(data: Partial<MeetingTableData>): void {
    if (data) {
      Object.assign(this.data, data);
    }
    // Re-render fully for simplicity (seat positions may change with new participants)
    this.render();
  }

  /** Force a specific participant as speaking (for real-time updates) */
  setSpeaking(participantId: string | null): void {
    this.currentSpeakingId = participantId;
    this.render();
  }

  /** Destroy and clean up */
  destroy(): void {
    this.seatElements.clear();
    if (this.wrapper) {
      this.wrapper.remove();
      this.wrapper = null;
    }
  }
}

export default MeetingTable;
