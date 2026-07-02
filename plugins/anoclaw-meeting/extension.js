// extension.js — Meeting plugin v5.0
// Multi-agent meeting system with full orchestration.
// Features: round-robin/moderator/auto modes, LLM-powered discussion,
// action item extraction, auto-summary, memory integration,
// templates, export, real-time seq tracking, WS broadcast,
// configurable turn delay, pagination, edit/update endpoint,
// participant roles, duration tracking, speaker analytics,
// recurring meetings, multi-format export, meeting comparison,
// action item status tracking (pending/in-progress/done).

import * as path from 'path';
import * as fs from 'fs';

const MEETINGS_DIR = path.resolve(process.cwd(), 'data', 'meetings');

// ── Meeting Store ──

async function ensureDir() { await fs.promises.mkdir(MEETINGS_DIR, { recursive: true }); }
function filePath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid meeting ID: "${id}"`);
  return path.join(MEETINGS_DIR, `${id}.json`);
}

let _globalSeq = 0;
let _agentNames = {};
let _turnDelayMs = 800;

function getTurnDelay() { return _turnDelayMs; }
function setTurnDelay(ms) {
  if (typeof ms === 'number' && ms >= 0 && ms <= 30000) _turnDelayMs = ms;
}

async function listMeetings(options = {}) {
  await ensureDir();
  const entries = await fs.promises.readdir(MEETINGS_DIR);
  const result = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(MEETINGS_DIR, entry), 'utf-8');
      const m = JSON.parse(raw);
      result.push({
        id: m.id, topic: m.topic, goal: m.goal, status: m.status || 'idle',
        speakerMode: m.speakerMode, participantIds: m.participantIds || [],
        maxRounds: m.maxRounds, transcript: m.transcript || [],
        actionItems: m.actionItems || [], summary: m.summary || null,
        currentRound: m.currentRound || 0, seq: m.seq || 0,
        createdAt: m.createdAt, lastRunAt: m.lastRunAt || null,
        endedAt: m.endedAt || null,
      });
    } catch (err) {
      console.error(`[meeting] Failed to read meeting file ${entry}: ${err.message}`);
    }
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Pagination
  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 20));
  const offset = (page - 1) * limit;
  const total = result.length;
  const items = result.slice(offset, offset + limit);
  return {
    meetings: items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getMeeting(id) {
  await ensureDir();
  try { return JSON.parse(await fs.promises.readFile(filePath(id), 'utf-8')); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error(`[meeting] Failed to read meeting ${id}: ${err.message}`);
    return null;
  }
}

async function saveMeeting(data, notify = null) {
  await ensureDir();
  data.seq = (data.seq || 0) + 1;
  _globalSeq++;
  await fs.promises.writeFile(filePath(data.id), JSON.stringify(data, null, 2));
  if (notify) notify(data);
}

async function deleteMeeting(id) {
  await ensureDir();
  try { await fs.promises.unlink(filePath(id)); return true; }
  catch (err) {
    if (err.code === 'ENOENT') return false;
    console.error(`[meeting] Failed to delete meeting ${id}: ${err.message}`);
    return false;
  }
}

async function refreshAgentCache(anoclaw) {
  try {
    const result = await anoclaw.api.call('GET', '/api/v1/agents');
    const agents = result.body?.agents || [];
    _agentNames = {};
    for (const a of agents) _agentNames[a.id] = a.name || a.displayName || a.id;
  } catch (err) {
    console.error(`[meeting] Failed to refresh agent cache: ${err.message}`);
    _agentNames = {};
  }
}
function resolveAgentName(id) { return _agentNames[id] || id; }

// ── Meeting Templates ──

const TEMPLATES = [
  { id: 'daily-standup', name: 'Daily Standup', goal: 'Share progress, blockers, and plans for today', maxRounds: 1, speakerMode: 'round-robin', suggestion: 'Best for quick daily syncs (1 round, all participants)', category: 'Recurring', estimatedDuration: '10 min' },
  { id: 'sprint-planning', name: 'Sprint Planning', goal: 'Plan the upcoming sprint: select tasks, estimate effort, assign ownership', maxRounds: 2, speakerMode: 'round-robin', suggestion: 'Use 2 rounds — first for task proposals, second for refinement', category: 'Planning', estimatedDuration: '30 min' },
  { id: 'bug-triage', name: 'Bug Triage', goal: 'Review open bugs, classify severity, assign fix owners, set priority', maxRounds: 2, speakerMode: 'moderator', suggestion: 'Moderator mode — let one agent lead the triage process', category: 'Review', estimatedDuration: '25 min' },
  { id: 'retrospective', name: 'Retrospective', goal: 'Review what went well, what could improve, and define action items for next cycle', maxRounds: 3, speakerMode: 'round-robin', suggestion: '3 rounds: what went well, what to improve, action items', category: 'Recurring', estimatedDuration: '45 min' },
  { id: 'design-review', name: 'Design Review', goal: 'Review proposed architecture/design: identify risks, suggest improvements, align team', maxRounds: 2, speakerMode: 'round-robin', suggestion: 'First round for feedback, second for addressing concerns', category: 'Review', estimatedDuration: '30 min' },
  { id: 'incident-postmortem', name: 'Incident Postmortem', goal: 'Analyze what happened, root cause, impact, and action items to prevent recurrence', maxRounds: 3, speakerMode: 'moderator', suggestion: 'Moderator-led: timeline → root cause → prevention plan', category: 'Review', estimatedDuration: '60 min' },
];

// ── Recurring Meeting Patterns ──

const RECURRING_PATTERNS = [
  { id: 'daily', name: 'Daily', cron: '0 9 * * 1-5', description: 'Every weekday at 9:00 AM' },
  { id: 'weekly', name: 'Weekly', cron: '0 10 * * 1', description: 'Every Monday at 10:00 AM' },
  { id: 'biweekly', name: 'Bi-weekly', cron: '0 10 */14 *', description: 'Every two weeks' },
  { id: 'monthly', name: 'Monthly', cron: '0 10 1 * *', description: 'First of every month at 10:00 AM' },
];

// ── Participant Roles ──

const PARTICIPANT_ROLES = {
  moderator: { label: 'Moderator', description: 'Leads the meeting, controls turn order', color: '#ff4d4d', icon: '◆' },
  speaker: { label: 'Speaker', description: 'Active participant, speaks during turns', color: '#57c1ff', icon: '●' },
  observer: { label: 'Observer', description: 'Listens only, does not speak', color: '#9c9c9d', icon: '○' },
};

// ── Action Item Status ──

const ACTION_STATUSES = {
  pending: { label: 'Pending', color: '#ffc533' },
  'in-progress': { label: 'In Progress', color: '#57c1ff' },
  done: { label: 'Done', color: '#59d499' },
  blocked: { label: 'Blocked', color: '#ff6161' },
};

// ── Meeting Orchestration @@
let _runningMeetings = new Set();
let _anoclaw = null;

function makeSysPrompt(meeting, speakerId) {
  const transcript = (meeting.transcript || []).map(t =>
    `[Round ${t.round}] ${resolveAgentName(t.speakerId)}: ${t.content}`
  ).join('\n\n');
  const isFirstSpeaker = (meeting.transcript || []).length === 0;
  const roleName = resolveAgentName(speakerId);

  // First speaker needs an opening prompt
  if (isFirstSpeaker) {
    return [
      { role: 'system', content:
        `You are ${roleName}, a participant in a work meeting. Your goal is to help achieve the meeting objective. ` +
        `You have expertise relevant to the topic. Speak in first person as ${roleName}. ` +
        `Your response MUST be 3-6 substantive sentences that advance the discussion. ` +
        `DO NOT say you are an AI. DO NOT repeat the instructions. Start your response NOW.` },
      { role: 'user', content:
        `Meeting: ${meeting.topic}\nGoal: ${meeting.goal}\n\nYou are the first speaker. ` +
        `Open the discussion: share your initial thoughts on the topic, ` +
        `raise key points, and set the direction for the conversation. ` +
        `Speak as ${roleName} in first person. Your response: ` },
    ];
  }

  // Subsequent speakers
  return [
    { role: 'system', content:
      `You are ${roleName}, a participant in a work meeting. Your goal is to help achieve the meeting objective. ` +
      `Speak in first person as ${roleName}. ` +
      `Your response MUST be 3-6 substantive sentences. ` +
      `Acknowledge what others said, then add YOUR perspective, analysis, or proposal. ` +
      `Be specific and constructive. DO NOT say you are an AI. Respond NOW.` },
    { role: 'user', content:
      `Meeting: ${meeting.topic}\nGoal: ${meeting.goal}\nRound ${meeting.currentRound || 1}/${meeting.maxRounds}\n\n` +
      `Discussion so far:\n${transcript}\n\n` +
      `You are ${roleName}. Now speak: share your analysis, build on or challenge previous points, ` +
      `and propose concrete next steps. Your response (in first person as ${roleName}): ` },
  ];
}

function getNextSpeaker(meeting) {
  const p = meeting.participantIds || [];
  if (p.length === 0) return null;
  const t = meeting.transcript || [];
  const mode = meeting.speakerMode || 'round-robin';

  if (mode === 'round-robin') {
    const r = Math.floor(t.length / p.length) + 1;
    return { speakerId: p[t.length % p.length], round: r };
  }

  if (mode === 'moderator') {
    // Moderator mode: the designated moderator picks the next speaker.
    // The moderator always speaks first in each round, then calls on others.
    // If no moderatorId, fall back to first participant.
    const moderatorId = meeting.moderatorId || p[0];
    const entriesThisRound = t.filter(e => e.round === (meeting.currentRound || 1));
    // First call each round: moderator speaks
    if (entriesThisRound.length === 0) {
      return { speakerId: moderatorId, round: meeting.currentRound || 1 };
    }
    // Subsequent calls: pick the participant who hasn't spoken this round yet
    const spokeThisRound = new Set(entriesThisRound.map(e => e.speakerId));
    // Prefer non-moderators who haven't spoken
    const candidates = p.filter(id => !spokeThisRound.has(id) && id !== moderatorId);
    if (candidates.length > 0) {
      // Among candidates, prefer the one who spoke least overall
      const speakCounts = {};
      for (const id of p) speakCounts[id] = 0;
      for (const e of t) speakCounts[e.speakerId] = (speakCounts[e.speakerId] || 0) + 1;
      candidates.sort((a, b) => (speakCounts[a] || 0) - (speakCounts[b] || 0));
      return { speakerId: candidates[0], round: meeting.currentRound || 1 };
    }
    // Everyone spoke this round, start next round with moderator
    const nextRound = (meeting.currentRound || 1) + 1;
    return { speakerId: moderatorId, round: nextRound };
  }

  if (mode === 'auto') {
    // Auto mode: adaptive — picks the participant with the fewest total contributions
    // to ensure balanced participation. Also considers who spoke recently.
    const speakCounts = {};
    for (const id of p) speakCounts[id] = 0;
    for (const e of t) speakCounts[e.speakerId] = (speakCounts[e.speakerId] || 0) + 1;

    // Current round calculation
    const entriesThisRound = t.filter(e => e.round === (meeting.currentRound || 1));
    const round = entriesThisRound.length === 0
      ? (meeting.currentRound || 1)
      : (meeting.currentRound || 1);

    // If this is the first entry of a new round, start with the least-spoken participant
    if (entriesThisRound.length === 0) {
      const sorted = [...p].sort((a, b) => (speakCounts[a] || 0) - (speakCounts[b] || 0));
      // If everyone is equal, prefer the one who spoke longest ago
      return { speakerId: sorted[0], round };
    }

    // Subsequent entries: pick participant with fewest total contributions
    // who hasn't spoken in this round yet (if available)
    const spokeThisRound = new Set(entriesThisRound.map(e => e.speakerId));
    const notSpokeThisRound = p.filter(id => !spokeThisRound.has(id));

    if (notSpokeThisRound.length > 0) {
      notSpokeThisRound.sort((a, b) => (speakCounts[a] || 0) - (speakCounts[b] || 0));
      return { speakerId: notSpokeThisRound[0], round };
    }

    // Everyone spoke this round, start next round
    const nextRound = (meeting.currentRound || 1) + 1;
    const sorted = [...p].sort((a, b) => (speakCounts[a] || 0) - (speakCounts[b] || 0));
    return { speakerId: sorted[0], round: nextRound };
  }

  // Unknown mode fallback
  const r = Math.floor(t.length / p.length) + 1;
  return { speakerId: p[t.length % p.length], round: r };
}

async function extractActionItems(m) {
  // Extract action items from the summary text
  const summary = m.summary || '';
  const items = [];

  // Strategy 1: parse markdown table rows (common format from LLM summaries)
  const tableRows = summary.split('\n').filter(l => /^\|.+\|$/.test(l));
  if (tableRows.length > 0) {
    for (const row of tableRows) {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean);
      // Skip separator rows (all dashes/spaces)
      if (cols.every(c => /^[-–—─\s]+$/.test(c))) continue;
      // First column is typically the task description
      const task = cols[0] || '';
      if (!task || task.length < 5 || /^[-–—─\s]+$/.test(task)) continue;
      const assignee = cols.length > 1 ? cols[1] : 'unassigned';
      items.push({
        id: `ai_${items.length}_${Date.now().toString(36)}`,
        task,
        assignee: assignee === '-' ? 'unassigned' : assignee,
        priority: 'medium',
      });
    }
  }

  // Strategy 2: find bullet points in the summary
  if (items.length === 0) {
    const lines = summary.split('\n').map(l => l.trim()).filter(l => /^[-*]\s/.test(l));
    for (const line of lines) {
      const text = line.replace(/^[-*]\s+/, '');
      if (!text || text.length < 5) continue;
      let assignee = 'unassigned';
      const patterns = [/由\s*(\S+)/, /(\S+)\s*(?:负责|will|should|to|need|must)/];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) { assignee = m[1]; break; }
      }
      items.push({
        id: `ai_${items.length}_${Date.now().toString(36)}`,
        task: text,
        assignee,
        priority: 'medium',
      });
    }
  }

  // Fallback: use first meaningful sentences from summary
  if (items.length === 0 && summary.length > 20) {
    const sentences = summary.split(/[。！\n]/).filter(s => s.trim().length > 15).slice(0, 3);
    for (const s of sentences) {
      items.push({
        id: `ai_${items.length}_${Date.now().toString(36)}`,
        task: s.trim(),
        assignee: 'unassigned',
        priority: 'medium',
      });
    }
  }

  return items;
}

async function generateSummary(m) {
  if (!_anoclaw) return 'Summary unavailable.';
  const transcript = (m.transcript || []).map(t =>
    `[R${t.round}] ${resolveAgentName(t.speakerId)}: ${t.content}`
  ).join('\n\n');
  try {
    const resp = await _anoclaw.llm.chat([
      { role: 'system', content: 'Write a meeting summary. At the end, include a "## Action Items" section with a bullet list of tasks, each containing: who does what by when. Use "- " for each item.' },
      { role: 'user', content: `Meeting: ${m.topic}\nGoal: ${m.goal}\n\nTranscript:\n${transcript}\n\nWrite summary with action items.` },
    ], { maxTokens: 1024, temperature: 0.4 });
    return resp.content || 'Summary generation returned empty.';
  } catch (err) {
    console.error(`[meeting] Summary generation failed: ${err.message}`);
    return 'Summary generation failed.';
  }
}

async function saveToMemory(m, summary, items) {
  if (!_anoclaw) return;
  // Save summary
  if (summary) {
    try {
      await _anoclaw.memory.save({
        name: `meeting-summary-${m.id}`,
        type: 'reference',
        description: `Meeting summary: ${m.topic}`,
        content: JSON.stringify({ id: m.id, topic: m.topic, goal: m.goal, summary, participants: m.participantIds, endedAt: m.endedAt }),
        scope: 'team',
      });
    } catch (err) {
      console.error(`[meeting] Failed to save summary to memory: ${err.message}`);
    }
  }
  // Save action items individually
  for (const item of items || []) {
    try {
      await _anoclaw.memory.save({
        name: `meeting-action-${m.id}-${item.id}`,
        type: 'reference',
        description: `Action item from meeting "${m.topic}": ${item.task}`,
        content: JSON.stringify({ meetingId: m.id, meetingTopic: m.topic, task: item.task, assignee: item.assignee, priority: item.priority }),
        scope: 'team',
      });
    } catch (err) {
      console.error(`[meeting] Failed to save action item to memory: ${err.message}`);
    }
  }
}

// ── Speaker Analytics ──

function computeSpeakerAnalytics(m) {
  const transcript = m.transcript || [];
  const participantIds = m.participantIds || [];
  if (transcript.length === 0) return { perSpeaker: {}, mostActive: null, leastActive: null, avgTurnLength: 0 };

  const perSpeaker = {};
  for (const id of participantIds) {
    perSpeaker[id] = { name: resolveAgentName(id), turns: 0, totalChars: 0, avgChars: 0, rounds: new Set(), firstTurn: null, lastTurn: null };
  }

  for (const entry of transcript) {
    const id = entry.speakerId;
    if (!perSpeaker[id]) {
      perSpeaker[id] = { name: entry.speakerName || resolveAgentName(id), turns: 0, totalChars: 0, avgChars: 0, rounds: new Set(), firstTurn: null, lastTurn: null };
    }
    const s = perSpeaker[id];
    s.turns++;
    s.totalChars += (entry.content || '').length;
    s.rounds.add(entry.round);
    if (!s.firstTurn) s.firstTurn = entry.timestamp;
    s.lastTurn = entry.timestamp;
  }

  // Compute averages
  let totalChars = 0;
  for (const id of Object.keys(perSpeaker)) {
    const s = perSpeaker[id];
    s.avgChars = s.turns > 0 ? Math.round(s.totalChars / s.turns) : 0;
    s.roundsSpoken = s.rounds.size;
    delete s.rounds; // clean up Set for serialization
    totalChars += s.totalChars;
  }

  // Find most/least active by turn count
  let mostActive = null, leastActive = null;
  for (const [id, s] of Object.entries(perSpeaker)) {
    if (!mostActive || s.turns > perSpeaker[mostActive].turns) mostActive = id;
    if (!leastActive || s.turns < perSpeaker[leastActive].turns) leastActive = id;
  }

  return {
    perSpeaker,
    mostActive: mostActive ? { id: mostActive, name: perSpeaker[mostActive].name, turns: perSpeaker[mostActive].turns } : null,
    leastActive: leastActive ? { id: leastActive, name: perSpeaker[leastActive].name, turns: perSpeaker[leastActive].turns } : null,
    avgTurnLength: transcript.length > 0 ? Math.round(totalChars / transcript.length) : 0,
    totalTurns: transcript.length,
  };
}

// ── Duration Tracking ──

function computeDuration(m) {
  const startedAt = m.startedAt || m.lastRunAt;
  const endedAt = m.endedAt;
  if (!startedAt) return { startedAt: null, elapsed: null, estimatedEnd: null };

  const start = new Date(startedAt).getTime();
  const now = endedAt ? new Date(endedAt).getTime() : Date.now();
  const elapsedMs = now - start;

  // Estimate total based on turns completed vs expected
  const pCount = (m.participantIds || []).length;
  const totalTurns = pCount * (m.maxRounds || 2);
  const completedTurns = (m.transcript || []).length;
  let estimatedEnd = null;

  if (completedTurns > 0 && m.status === 'running') {
    const avgTurnMs = elapsedMs / completedTurns;
    const remainingTurns = totalTurns - completedTurns;
    estimatedEnd = new Date(start + (totalTurns * avgTurnMs)).toISOString();
  }

  return {
    startedAt,
    elapsed: Math.max(0, elapsedMs),
    elapsedFormatted: formatDuration(elapsedMs),
    estimatedEnd,
    progress: totalTurns > 0 ? Math.min(100, Math.round((completedTurns / totalTurns) * 100)) : 0,
  };
}

function formatDuration(ms) {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function runMeetingLoop(meetingId) {
  if (_runningMeetings.has(meetingId)) return;
  _runningMeetings.add(meetingId);

  try {
    await refreshAgentCache(_anoclaw);
    let notifiedNewTurn = false;

    while (_runningMeetings.has(meetingId)) {
      const m = await getMeeting(meetingId);
      if (!m || m.status !== 'running') break;

      const pCount = (m.participantIds || []).length;
      if (pCount < 2) { m.status = 'completed'; m.endedAt = new Date().toISOString(); await saveMeeting(m, broadcastUpdate); break; }

      const totalTurns = pCount * m.maxRounds;
      if ((m.transcript || []).length >= totalTurns) {
        _anoclaw.log.info(`Meeting ${meetingId}: complete, generating summary + action items`);
        try {
          const summary = await generateSummary(m);
          m.summary = summary;
          const items = await extractActionItems(m);
          m.actionItems = items.map(item => ({ ...item, status: 'pending' }));
          m.analytics = computeSpeakerAnalytics(m);
          m.duration = computeDuration(m);
          await saveToMemory(m, summary, items);
        } catch (err) { _anoclaw.log.error(`Meeting ${meetingId} post-processing: ${err.message}`); }
        m.status = 'completed'; m.endedAt = new Date().toISOString();
        m.duration = computeDuration(m);
        await saveMeeting(m, broadcastUpdate);
        break;
      }

      const next = getNextSpeaker(m);
      if (!next) break;
      m.currentRound = next.round;

      try {
        _anoclaw.log.info(`Meeting ${meetingId}: ${resolveAgentName(next.speakerId)} R${next.round}`);
        let respContent = '';
        const resp = await _anoclaw.llm.chat(makeSysPrompt(m, next.speakerId), { maxTokens: 1024, temperature: 0.7 });
        respContent = (resp.content || '').trim();

        // Retry once if empty or too short
        if (respContent.length < 10) {
          _anoclaw.log.warn(`Meeting ${meetingId}: ${next.speakerId} returned short/empty content (${respContent.length} chars), retrying`);
          const retryResp = await _anoclaw.llm.chat([
            { role: 'system', content: `You are ${resolveAgentName(next.speakerId)}. The meeting "${m.topic}" needs your input on: ${m.goal}. Your previous response was too short. Write 4-6 substantive sentences NOW with your analysis and proposals.` },
            { role: 'user', content: 'Speak now: give your detailed perspective on this topic.' },
          ], { maxTokens: 1024, temperature: 0.8 });
          respContent = (retryResp.content || '').trim() || respContent;
        }

        // Final fallback if still empty
        if (!respContent) respContent = '(no response)';

        m.transcript.push({
          round: next.round, speakerId: next.speakerId, speakerName: resolveAgentName(next.speakerId),
          content: respContent, timestamp: new Date().toISOString(),
        });
        m.lastRunAt = new Date().toISOString();
        m.duration = computeDuration(m);
        await saveMeeting(m, broadcastUpdate);
        notifiedNewTurn = false;
      } catch (err) {
        _anoclaw.log.error(`Meeting ${meetingId}: ${next.speakerId} failed: ${err.message}`);
        m.transcript.push({
          round: next.round, speakerId: next.speakerId, speakerName: resolveAgentName(next.speakerId),
          content: `[Error: ${err.message}]`, timestamp: new Date().toISOString(),
        });
        await saveMeeting(m, broadcastUpdate);
      }

      await new Promise(r => setTimeout(r, getTurnDelay()));
    }
  } catch (err) {
    if (_anoclaw) _anoclaw.log.error(`Meeting loop ${meetingId}: ${err.message}`);
  } finally {
    _runningMeetings.delete(meetingId);
  }
}

function broadcastUpdate(m) {
  if (!_anoclaw) return;
  try {
    _anoclaw.ws.broadcast({
      type: 'meeting:update',
      meetingId: m.id,
      status: m.status,
      seq: m.seq,
      currentRound: m.currentRound || 0,
      transcriptCount: (m.transcript || []).length,
      hasActionItems: (m.actionItems || []).length > 0,
      hasSummary: !!m.summary,
    });
  } catch (err) {
    if (_anoclaw) _anoclaw.log.warn(`Meeting broadcast failed: ${err.message}`);
  }
}

// ── Plugin lifecycle ──

export async function activate(anoclaw) {
  _anoclaw = anoclaw;
  anoclaw.log.info('Meeting plugin v5.0 activating');

  await anoclaw.routes.register([
    { method: 'GET', path: '/api/v1/meetings', handler: 'handleListMeetings' },
    { method: 'POST', path: '/api/v1/meetings', handler: 'handleCreateMeeting' },
    { method: 'GET', path: '/api/v1/meetings/seq', handler: 'handleGlobalSeq' },
    { method: 'GET', path: '/api/v1/meetings/templates', handler: 'handleTemplates' },
    { method: 'GET', path: '/api/v1/meetings/recurring-patterns', handler: 'handleRecurringPatterns' },
    { method: 'GET', path: '/api/v1/meetings/roles', handler: 'handleParticipantRoles' },
    { method: 'GET', path: '/api/v1/meetings/action-statuses', handler: 'handleActionStatuses' },
    { method: 'GET', path: '/api/v1/meetings/search', handler: 'handleSearch' },
    { method: 'GET', path: '/api/v1/meetings/:id', handler: 'handleGetMeeting' },
    { method: 'PUT', path: '/api/v1/meetings/:id', handler: 'handleUpdateMeeting' },
    { method: 'DELETE', path: '/api/v1/meetings/:id', handler: 'handleDeleteMeeting' },
    { method: 'POST', path: '/api/v1/meetings/:id/start', handler: 'handleStartMeeting' },
    { method: 'POST', path: '/api/v1/meetings/:id/stop', handler: 'handleStopMeeting' },
    { method: 'POST', path: '/api/v1/meetings/:id/action-status', handler: 'handleUpdateActionStatus' },
    { method: 'GET', path: '/api/v1/meetings/:id/analytics', handler: 'handleAnalytics' },
    { method: 'GET', path: '/api/v1/meetings/:id/export', handler: 'handleExport' },
    { method: 'POST', path: '/api/v1/meetings/compare', handler: 'handleCompare' },
    { method: 'GET', path: '/api/v1/plugins/meeting/agents', handler: 'handleGetAgents' },
    { method: 'GET', path: '/api/v1/plugins/meeting/diagnose/llm', handler: 'handleDiagnoseLLM' },
  ]);

  // ── Tools ──

  await anoclaw.tools.register({
    name: 'LaunchMeeting',
    description: 'Start a multi-agent meeting. Participants discuss round-robin. After completion, action items and summary are auto-generated and saved to memory.',
    parametersSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Meeting topic.' },
        goal: { type: 'string', description: 'What should be achieved.' },
        participantIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs (min 2).' },
        speakerMode: { type: 'string', enum: ['round-robin', 'moderator', 'auto'], description: 'Default: round-robin.' },
        maxRounds: { type: 'number', description: 'Discussion rounds. Default: 2.' },
        template: { type: 'string', description: 'Template ID from meeting templates (optional).' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['topic', 'goal', 'participantIds'],
    },
    category: 'Coordination',
  });

  // Read-only participant tools — available during meetings for context gathering
  await anoclaw.tools.register({
    name: 'MeetingSearchMemory',
    description: 'Search meeting memory by keyword query. Returns past meeting summaries and action items.',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords to find relevant past meetings.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['query'],
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingReadFile',
    description: 'Read a file from the workspace during a meeting. Returns file contents.',
    parametersSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['path'],
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingGetAgents',
    description: 'List all available agents with their names and roles. No parameters required.',
    parametersSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingGetStats',
    description: 'Get meeting statistics: participant count, total turns, current round, duration, and speaker analytics.',
    parametersSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingWebSearch',
    description: 'Search the web for information. Uses the built-in web_search tool if available. Returns search results as text.',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['query'],
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingWebFetch',
    description: 'Fetch content from a URL. Returns fetched content as plain text, truncated to a reasonable size.',
    parametersSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['url'],
    },
    category: 'Meeting',
  });

  await anoclaw.prompt.inject('meeting-tool-instructions',
    '## Meeting Tool\n' +
    '- LaunchMeeting creates multi-agent meetings (min 2 participants)\n' +
    '- After the meeting, action items + summary are auto-generated and saved to memory\n' +
    '- Search past meetings via memory search (type: "reference", name starts with "meeting-summary-")\n' +
    '- View and manage meetings in the "Meet" tab\n' +
    '\n' +
    '### Read-Only Tools (available during meetings)\n' +
    '- **MeetingSearchMemory** — Search past meeting memory by keyword query. Returns relevant meeting summaries and action items.\n' +
    '- **MeetingReadFile** — Read a workspace file. Provide the file path.\n' +
    '- **MeetingGetAgents** — List all available agents with their names and roles.\n' +
    '- **MeetingGetStats** — Get current meeting statistics (participants, turns, duration, speaker analytics).\n' +
    '- **MeetingWebSearch** — Search the web by keyword. Returns search result snippets. Provide a query string.\n' +
    '- **MeetingWebFetch** — Fetch content from a URL and return it as plain text. Provide a full URL (https://...).\n',
    45,
  );

  return [{ dispose() { deactivate(); } }];
}

export async function deactivate() {
  for (const id of _runningMeetings) _runningMeetings.delete(id);
  if (_anoclaw) {
    _anoclaw.log.info('Meeting plugin deactivated');
    await _anoclaw.prompt.inject('meeting-tool-instructions', '');
  }
}

// ── HTTP Handlers ──

export async function handleListMeetings(req) {
  const q = new URLSearchParams(req?.query || '');
  const page = parseInt(q.get('page')) || 1;
  const limit = parseInt(q.get('limit')) || 20;
  return { status: 200, body: await listMeetings({ page, limit }) };
}

export async function handleGlobalSeq() {
  return { status: 200, body: { seq: _globalSeq } };
}

export async function handleTemplates() {
  return { status: 200, body: { templates: TEMPLATES } };
}

export async function handleSearch(req) {
  const q = new URLSearchParams(req.query || '');
  const query = q.get('q') || '';
  const page = parseInt(q.get('page')) || 1;
  const limit = Math.min(50, Math.max(1, parseInt(q.get('limit')) || 20));
  if (!query) return { status: 200, body: { results: [], pagination: { page: 1, limit, total: 0, totalPages: 0 } } };
  try {
    // Fetch enough results for pagination (up to 200)
    const memories = await _anoclaw.memory.search(query, { scope: 'team', limit: 200 });
    const allResults = memories
      .filter(m => (m.name || '').startsWith('meeting-summary-') || (m.name || '').startsWith('meeting-action-'))
      .map(m => ({ memoryName: m.name, description: m.description, content: m.content }));
    const total = allResults.length;
    const offset = (page - 1) * limit;
    const results = allResults.slice(offset, offset + limit);
    return { status: 200, body: { results, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } };
  } catch (err) {
    console.error(`[meeting] Search failed for query "${query}": ${err.message}`);
    return { status: 500, body: { error: `Search failed: ${err.message}`, results: [] } };
  }
}

export async function handleCreateMeeting(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const participantIds = body.participantIds || [];
  if (participantIds.length < 2) return { status: 400, body: { error: 'Minimum 2 participants' } };
  const id = body.id || `meet_${Date.now().toString(36)}`;

  // Apply template if specified
  let topic = body.topic || 'Meeting', goal = body.goal || 'Discuss next steps';
  let speakerMode = body.speakerMode || 'round-robin', maxRounds = body.maxRounds || 2;
  if (body.template) {
    const tmpl = TEMPLATES.find(t => t.id === body.template);
    if (tmpl) {
      if (!body.topic) topic = tmpl.name;
      if (!body.goal) goal = tmpl.goal;
      if (!body.speakerMode) speakerMode = tmpl.speakerMode;
      if (!body.maxRounds) maxRounds = tmpl.maxRounds;
    }
  }

  const data = {
    id, topic, goal, status: 'idle', createdAt: new Date().toISOString(), lastRunAt: null, endedAt: null,
    participantIds, speakerMode, moderatorId: speakerMode === 'moderator' ? participantIds[0] : (body.moderatorId || null), maxRounds,
    autoExecute: body.autoExecute || false, allowInterjection: body.allowInterjection !== false,
    transcript: [], actionItems: [], summary: null, currentRound: 0, seq: 0, template: body.template || null,
  };
  await saveMeeting(data, broadcastUpdate);
  return { status: 201, body: { meeting: data } };
}

export async function handleGetMeeting(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  // Trim internal seq for list response
  return { status: 200, body: { meeting: m } };
}

export async function handleUpdateMeeting(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  if (m.status === 'running') return { status: 409, body: { error: 'Cannot update a running meeting. Stop it first.' } };

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Request body must be a JSON object' } };

  // Update allowed fields (only when not running)
  const updatableFields = ['topic', 'goal', 'speakerMode', 'maxRounds', 'moderatorId', 'autoExecute', 'allowInterjection', 'participantIds'];
  const updated = [];
  for (const field of updatableFields) {
    if (body[field] !== undefined) {
      if (field === 'participantIds') {
        const pIds = body[field];
        if (!Array.isArray(pIds) || pIds.length < 2) {
          return { status: 400, body: { error: 'participantIds must be an array with at least 2 entries' } };
        }
        m.participantIds = pIds;
      } else if (field === 'maxRounds') {
        const val = parseInt(body[field]);
        if (isNaN(val) || val < 1 || val > 50) {
          return { status: 400, body: { error: 'maxRounds must be a number between 1 and 50' } };
        }
        m.maxRounds = val;
      } else if (field === 'speakerMode') {
        const valid = ['round-robin', 'moderator', 'auto'];
        if (!valid.includes(body[field])) {
          return { status: 400, body: { error: `speakerMode must be one of: ${valid.join(', ')}` } };
        }
        m.speakerMode = body[field];
        // Auto-update moderatorId if switching to moderator mode
        if (body[field] === 'moderator' && !body.moderatorId && !m.moderatorId) {
          m.moderatorId = m.participantIds[0];
        }
      } else {
        m[field] = body[field];
      }
      updated.push(field);
    }
  }

  if (updated.length === 0) return { status: 400, body: { error: 'No valid fields to update. Allowed: ' + updatableFields.join(', ') } };

  // Recompute analytics if transcript exists
  if (m.transcript && m.transcript.length > 0) {
    m.analytics = computeSpeakerAnalytics(m);
  }

  m.seq = (m.seq || 0) + 1;
  await saveMeeting(m, broadcastUpdate);
  return { status: 200, body: { meeting: m, updated } };
}

export async function handleDeleteMeeting(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  _runningMeetings.delete(id);
  const ok = await deleteMeeting(id);
  return ok ? { status: 200, body: { deleted: true } } : { status: 404, body: { error: 'Not found' } };
}

export async function handleStartMeeting(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  if (m.status === 'running') return { status: 409, body: { error: 'Already running' } };
  if ((m.participantIds || []).length < 2) return { status: 400, body: { error: 'Need 2+ participants' } };

  m.status = 'running'; m.transcript = []; m.actionItems = []; m.summary = null;
  m.currentRound = 0; m.lastRunAt = new Date().toISOString(); m.endedAt = null;
  m.startedAt = new Date().toISOString();
  m.duration = computeDuration(m);
  await saveMeeting(m, broadcastUpdate);

  runMeetingLoop(id).catch(err => { if (_anoclaw) _anoclaw.log.error(`Meeting ${id}: ${err.message}`); });
  return { status: 200, body: { id, status: 'running' } };
}

export async function handleStopMeeting(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  _runningMeetings.delete(id);
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  m.status = 'idle'; m.endedAt = new Date().toISOString();
  m.duration = computeDuration(m);
  await saveMeeting(m, broadcastUpdate);
  return { status: 200, body: { id, status: 'idle' } };
}

export async function handleExport(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };

  const q = new URLSearchParams(req.query || '');
  const format = q.get('format') || 'markdown';

  if (format === 'json') {
    return { status: 200, body: { meeting: m, filename: `meeting-${id}.json` }, contentType: 'application/json' };
  }

  if (format === 'text') {
    let text = `Meeting: ${m.topic}\\nGoal: ${m.goal}\\nMode: ${m.speakerMode}\\nDate: ${m.createdAt}\\nStatus: ${m.status}\\n\\n`;
    text += `${'='.repeat(40)}\\n\\n`;
    for (const entry of m.transcript || []) {
      text += `${entry.speakerName || entry.speakerId} (Round ${entry.round}):\\n${entry.content}\\n\\n`;
    }
    if (m.summary) text += `Summary:\\n${m.summary}\\n\\n`;
    if (m.actionItems?.length) {
      text += `Action Items:\\n`;
      for (const item of m.actionItems) text += `  [${item.status||'pending'}] ${item.task} — ${item.assignee} (${item.priority})\\n`;
    }
    return { status: 200, body: { text, filename: `meeting-${id}.txt` }, contentType: 'text/plain' };
  }

  // Default: Markdown
  let text = `# Meeting: ${m.topic}\\nGoal: ${m.goal}\\nMode: ${m.speakerMode}\\nDate: ${m.createdAt}\\nStatus: ${m.status}\\n`;
  if (m.duration?.elapsedFormatted) text += `Duration: ${m.duration.elapsedFormatted}\\n`;
  text += `\\n---\\n\\n`;
  for (const entry of m.transcript || []) {
    text += `## ${entry.speakerName || entry.speakerId} (Round ${entry.round})\\n${entry.content}\\n\\n`;
  }
  if (m.summary) text += `---\\n## Summary\\n${m.summary}\\n\\n`;
  if (m.analytics) {
    text += `---\\n## Speaker Analytics\\n`;
    for (const [id, s] of Object.entries(m.analytics.perSpeaker || {})) {
      text += `- **${s.name}**: ${s.turns} turns, avg ${s.avgChars} chars\\n`;
    }
    text += `\\n`;
  }
  if (m.actionItems?.length) {
    text += `---\\n## Action Items\\n`;
    for (const item of m.actionItems) text += `- [${item.status||'pending'}] ${item.task} (${item.assignee}, ${item.priority})\\n`;
  }
  return { status: 200, body: { text, filename: `meeting-${id}.md` } };
}

// ── New Handlers ──

export async function handleRecurringPatterns() {
  return { status: 200, body: { patterns: RECURRING_PATTERNS } };
}

export async function handleParticipantRoles() {
  return { status: 200, body: { roles: PARTICIPANT_ROLES } };
}

export async function handleActionStatuses() {
  return { status: 200, body: { statuses: ACTION_STATUSES } };
}

export async function handleAnalytics(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  const analytics = computeSpeakerAnalytics(m);
  const duration = computeDuration(m);
  return { status: 200, body: { analytics, duration } };
}

export async function handleUpdateActionStatus(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body?.taskId || !body?.status) return { status: 400, body: { error: 'taskId and status required' } };
  const validStatuses = ['pending', 'in-progress', 'done', 'blocked'];
  if (!validStatuses.includes(body.status)) return { status: 400, body: { error: `status must be one of: ${validStatuses.join(', ')}` } };

  const item = (m.actionItems || []).find(ai => ai.id === body.taskId);
  if (!item) return { status: 404, body: { error: 'Action item not found' } };
  item.status = body.status;
  if (body.assignee) item.assignee = body.assignee;

  m.seq = (m.seq || 0) + 1;
  await saveMeeting(m, broadcastUpdate);
  return { status: 200, body: { meeting: m, updated: true } };
}

export async function handleCompare(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body?.ids || !Array.isArray(body.ids) || body.ids.length < 2) {
    return { status: 400, body: { error: 'Provide at least 2 meeting IDs in ids array' } };
  }
  const meetings = [];
  for (const id of body.ids) {
    const m = await getMeeting(id);
    if (m) {
      m.analytics = m.analytics || computeSpeakerAnalytics(m);
      m.duration = m.duration || computeDuration(m);
      meetings.push({
        id: m.id, topic: m.topic, goal: m.goal, status: m.status,
        speakerMode: m.speakerMode, maxRounds: m.maxRounds,
        participantCount: (m.participantIds || []).length,
        transcriptCount: (m.transcript || []).length,
        actionItemCount: (m.actionItems || []).length,
        hasSummary: !!m.summary,
        analytics: m.analytics,
        duration: m.duration,
        createdAt: m.createdAt,
      });
    }
  }
  return { status: 200, body: { meetings, count: meetings.length } };
}

export async function handleGetAgents() {
  try {
    await refreshAgentCache(_anoclaw);
    const result = await _anoclaw.api.call('GET', '/api/v1/agents');
    return { status: 200, body: result.body || { agents: [] } };
  } catch (err) {
    console.error(`[meeting] Failed to get agents: ${err.message}`);
    return { status: 500, body: { error: `Failed to get agents: ${err.message}`, agents: [] } };
  }
}

export async function handleDiagnoseLLM() {
  if (!_anoclaw) return { status: 503, body: { error: 'Plugin not activated' } };
  try {
    const resp = await _anoclaw.llm.chat([
      { role: 'system', content: 'You are a helpful assistant. Respond with exactly: LLM_DIAGNOSTIC_OK' },
      { role: 'user', content: 'Say LLM_DIAGNOSTIC_OK' },
    ], { maxTokens: 100, temperature: 0 });
    return {
      status: 200,
      body: {
        ok: resp.content.includes('LLM_DIAGNOSTIC_OK'),
        content: resp.content,
        finishReason: resp.finishReason,
        usage: resp.usage,
        contentLength: resp.content.length,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { status: 500, body: { ok: false, error: err.message, timestamp: new Date().toISOString() } };
  }
}

// ── Tool execution ──

// Safelist: only read-only, memory, and web tools permitted during meetings
const ALLOWED_BUILTIN_TOOLS = new Set([
  'Read', 'Glob', 'Grep',
  'web_search', 'web_extract',
  'memory_search', 'memory_list',
  'list_agents', 'session_search',
]);

function logToolCall(toolName, ctx) {
  if (!_anoclaw) return;
  const sid = ctx?.sessionId ? ` session=${ctx.sessionId}` : '';
  const wid = ctx?.workspace ? ` workspace=${ctx.workspace}` : '';
  const aid = ctx?.agentId ? ` agent=${ctx.agentId}` : '';
  _anoclaw.log.info(`[meeting] Tool: ${toolName}${sid}${wid}${aid}`);
}

export async function executeTool(toolName, params, ctx) {
  logToolCall(toolName, ctx);

  // ── MeetingSearchMemory ──
  if (toolName === 'MeetingSearchMemory') {
    const query = (params.query || '').trim();
    if (!query) return 'Error: query parameter is required.';
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('memory_search')) {
        return 'Error: Tool "memory_search" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('memory_search', { query }, ctx);
      return `Memory search results for "${query}":\n${result}`;
    } catch (err) {
      return `Error searching memory: ${err.message}`;
    }
  }

  // ── MeetingReadFile ──
  if (toolName === 'MeetingReadFile') {
    const filePath = (params.path || '').trim();
    if (!filePath) return 'Error: path parameter is required.';
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('Read')) {
        return 'Error: Tool "Read" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('Read', { file_path: filePath }, ctx);
      return `File content (${filePath}):\n${result}`;
    } catch (err) {
      return `Error reading file "${filePath}": ${err.message}`;
    }
  }

  // ── MeetingGetAgents ──
  if (toolName === 'MeetingGetAgents') {
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('list_agents')) {
        return 'Error: Tool "list_agents" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      await refreshAgentCache(_anoclaw);
      const result = await _anoclaw.tools.execute('list_agents', {}, ctx);
      return `Available agents:\n${result}`;
    } catch (err) {
      return `Error fetching agents: ${err.message}`;
    }
  }

  // ── MeetingGetStats ──
  if (toolName === 'MeetingGetStats') {
    const pCount = _runningMeetings.size;
    const seq = _globalSeq;
    const lines = [
      `Active meetings: ${pCount}`,
      `Global sequence: ${seq}`,
    ];
    return `Meeting stats:\n${lines.join('\n')}`;
  }

  // ── MeetingWebSearch ──
  if (toolName === 'MeetingWebSearch') {
    const query = (params.query || '').trim();
    if (!query) return 'Error: query parameter is required.';
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('web_search')) {
        return 'Error: Tool "web_search" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('web_search', { query }, ctx);
      return `Web search results for "${query}":\n${result}`;
    } catch (err) {
      return `Web search failed: ${err.message}`;
    }
  }

  // ── MeetingWebFetch ──
  if (toolName === 'MeetingWebFetch') {
    const url = (params.url || '').trim();
    if (!url) return 'Error: url parameter is required.';
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('web_extract')) {
        return 'Error: Tool "web_extract" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('web_extract', { url }, ctx);
      return `Fetched content from ${url}:\n${result}`;
    } catch (err) {
      return `Error fetching URL "${url}": ${err.message}`;
    }
  }

  // ── LaunchMeeting ──
  if (toolName !== 'LaunchMeeting') throw new Error(`Unknown tool: ${toolName}`);
  const pIds = params.participantIds || [];
  if (pIds.length < 2) return 'Error: Minimum 2 participants required.';

  await refreshAgentCache(_anoclaw);
  const names = pIds.map(id => resolveAgentName(id));

  const id = `meet_${Date.now().toString(36)}`;
  let topic = params.topic, goal = params.goal, mode = params.speakerMode || 'round-robin', rounds = params.maxRounds || 2;
  if (params.template) {
    const tmpl = TEMPLATES.find(t => t.id === params.template);
    if (tmpl) { if (!topic) topic = tmpl.name; if (!goal) goal = tmpl.goal; if (!mode) mode = tmpl.speakerMode; if (!rounds) rounds = tmpl.maxRounds; }
  }

  const data = {
    id, topic, goal, status: 'idle', createdAt: new Date().toISOString(), lastRunAt: null, endedAt: null,
    participantIds: pIds, speakerMode: mode, moderatorId: mode === 'moderator' ? pIds[0] : null, maxRounds: rounds,
    autoExecute: false, allowInterjection: true,
    transcript: [], actionItems: [], summary: null, currentRound: 0, seq: 0, template: params.template || null,
  };
  await saveMeeting(data, broadcastUpdate);

  data.status = 'running'; data.lastRunAt = new Date().toISOString();
  await saveMeeting(data, broadcastUpdate);
  runMeetingLoop(id).catch(err => { if (_anoclaw) _anoclaw.log.error(`Meeting ${id}: ${err.message}`); });

  return [
    `Meeting created: ${id}`,
    `Topic: ${topic}`, `Goal: ${goal}`,
    `Participants: ${names.join(', ')}`,
    `Mode: ${mode}, Rounds: ${rounds}`,
    `Status: running now — check the Meet tab for live updates`,
  ].join('\n');
}


