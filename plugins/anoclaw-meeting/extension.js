// extension.js - Meeting plugin v5.0
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
const MEETING_PLANS_DIR = path.join(MEETINGS_DIR, 'plans');

// ── Meeting Store ──

async function ensureDir() { await fs.promises.mkdir(MEETINGS_DIR, { recursive: true }); }
async function ensurePlanDir(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid meeting ID: "${id}"`);
  const dir = path.join(MEETING_PLANS_DIR, id);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}
function filePath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid meeting ID: "${id}"`);
  return path.join(MEETINGS_DIR, `${id}.json`);
}

let _globalSeq = 0;
let _agentNames = {};
let _turnDelayMs = 800;

const DEFAULT_CONTEXT_FILES = [
  'AGENTS.md',
  'package.json',
  'plugins/AGENTS.md',
  'plugins/anoclaw-meeting/plugin.json',
  'plugins/anoclaw-meeting/extension.js',
  'plugins/anoclaw-meeting/frontend/index.html',
];

const CONTEXT_GREP_GLOBS = [
  'src/**/*.{ts,tsx,js}',
  'plugins/**/*.{js,ts,json,html,md}',
  'config/**/*.{yaml,yml,json}',
  'skills/**/*.md',
];

const DEFAULT_MEETING_ALLOWED_TOOLS = ['memory.search', 'Grep'];
const MAX_MEETING_ALLOWED_TOOLS = 16;
const MAX_TOOL_PROBE_TEMPLATES = 8;
const DEFAULT_TOOL_PROBE_BUDGET = 2;
const MAX_TOOL_PROBE_BUDGET = 6;
const BLOCKED_MEETING_TOOL_NAMES = new Set([
  'Write', 'Edit', 'Bash',
  'KillProcess', 'DeleteFile', 'MoveFile',
  'HireEmployee', 'TaskAssign', 'SubAgentSpawn',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'what', 'when',
  'where', 'which', 'should', 'would', 'could', 'about', 'have', 'has', 'are',
  'is', 'to', 'of', 'in', 'on', 'a', 'an', 'or', 'as', 'by', 'be', 'it',
  'meeting', 'discuss', 'plan', '方案', '计划', '讨论', '项目', '功能', '优化',
]);

function getTurnDelay() { return _turnDelayMs; }
function setTurnDelay(ms) {
  if (typeof ms === 'number' && ms >= 0 && ms <= 30000) _turnDelayMs = ms;
}

function normalizeToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (raw === 'memory_search') return 'memory.search';
  if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(raw)) return '';
  return raw;
}

function normalizeAllowedToolNames(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_MEETING_ALLOWED_TOOLS;
  const names = [];
  for (const item of raw) {
    const name = normalizeToolName(item);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= MAX_MEETING_ALLOWED_TOOLS) break;
  }
  return names.length ? names : [...DEFAULT_MEETING_ALLOWED_TOOLS];
}

function normalizeToolProbeBudget(value) {
  const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : DEFAULT_TOOL_PROBE_BUDGET;
  return Math.max(0, Math.min(MAX_TOOL_PROBE_BUDGET, parsed));
}

function sanitizeProbeParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const json = JSON.stringify(params);
  if (!json || json.length > 4000) return {};
  return JSON.parse(json);
}

function normalizeToolProbeTemplates(value, allowedToolNames = DEFAULT_MEETING_ALLOWED_TOOLS) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(normalizeAllowedToolNames(allowedToolNames));
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const toolName = normalizeToolName(item.toolName || item.name);
    if (!toolName || !allowed.has(toolName)) continue;
    result.push({
      toolName,
      purpose: truncateText(String(item.purpose || 'configured probe'), 180),
      params: sanitizeProbeParams(item.params),
    });
    if (result.length >= MAX_TOOL_PROBE_TEMPLATES) break;
  }
  return result;
}

function getMeetingAllowedToolSet(meeting) {
  return new Set(normalizeAllowedToolNames(meeting?.allowedToolNames));
}

function fillProbeTemplateValue(value, meeting, turn, terms) {
  if (typeof value === 'string') {
    const replacements = {
      topic: meeting.topic || '',
      goal: meeting.goal || '',
      phase: debatePhaseForTurn(meeting, turn.round),
      round: String(turn.round),
      speakerId: turn.speakerId || '',
      speakerName: resolveAgentName(turn.speakerId),
      term: terms[0] || '',
      terms: terms.join(' '),
    };
    return value.replace(/\{\{(\w+)\}\}/g, (_m, key) => replacements[key] ?? '');
  }
  if (Array.isArray(value)) return value.map(v => fillProbeTemplateValue(v, meeting, turn, terms));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) out[key] = fillProbeTemplateValue(nested, meeting, turn, terms);
    return out;
  }
  return value;
}

function summarizeProbeParams(params) {
  const text = JSON.stringify(params || {});
  return truncateText(text, 320);
}

async function executeMeetingToolProbe(toolName, params, meta, ctx) {
  const startedAt = Date.now();
  const entry = {
    toolName,
    purpose: meta?.purpose || 'tool probe',
    query: meta?.query || params?.query || params?.pattern || params?.url || params?.path || '',
    params: summarizeProbeParams(params),
    summary: '',
    durationMs: 0,
  };
  try {
    let result;
    if (toolName === 'memory.search') {
      const query = String(params.query || '').trim();
      const limit = Math.max(1, Math.min(10, parseInt(params.limit) || 3));
      const memories = await _anoclaw.memory.search(query, { scope: params.scope || 'team', limit, fuzzy: params.fuzzy !== false });
      result = (memories || []).map(m => `${m.name}: ${truncateText(m.description || m.content || '', 260)}`).join('\n');
    } else {
      if (BLOCKED_MEETING_TOOL_NAMES.has(toolName)) {
        throw new Error(`Tool "${toolName}" is blocked for meeting probes`);
      }
      result = await _anoclaw.tools.execute(toolName, params || {}, ctx);
    }
    entry.summary = truncateText(String(result || 'No result.'), 1400);
  } catch (err) {
    entry.summary = `Error: ${err.message}`;
    entry.error = err.message;
  } finally {
    entry.durationMs = Date.now() - startedAt;
  }
  return entry;
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
        decisionPlan: m.decisionPlan || null,
        contextBundle: m.contextBundle ? {
          generatedAt: m.contextBundle.generatedAt,
          mode: m.contextBundle.mode,
          terms: m.contextBundle.terms || [],
          fileCount: (m.contextBundle.files || []).length,
          grepCount: (m.contextBundle.grep || []).length,
          memoryCount: (m.contextBundle.memories || []).length,
          errors: m.contextBundle.errors || [],
        } : null,
        currentRound: m.currentRound || 0, seq: m.seq || 0,
        allowedToolNames: normalizeAllowedToolNames(m.allowedToolNames),
        toolProbeBudget: normalizeToolProbeBudget(m.toolProbeBudget),
        toolProbeTemplateCount: normalizeToolProbeTemplates(m.toolProbeTemplates, m.allowedToolNames).length,
        minimumQualityScore: normalizeQualityThreshold(m.minimumQualityScore),
        enforceQualityGate: m.enforceQualityGate !== false,
        planQuality: m.planQuality || null,
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

function truncateText(value, max = 6000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.72));
  const tail = text.slice(text.length - Math.floor(max * 0.22));
  return `${head}\n\n[... truncated ${text.length - head.length - tail.length} chars ...]\n\n${tail}`;
}

function extractContextTerms(meeting) {
  const raw = `${meeting.topic || ''} ${meeting.goal || ''} ${meeting.contextQuery || ''}`;
  const terms = raw
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]{3,}/gu) || [];
  const scored = new Map();
  for (const term of terms) {
    if (STOP_WORDS.has(term)) continue;
    scored.set(term, (scored.get(term) || 0) + 1);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .slice(0, 6);
}

async function safeReadContextFile(file, sessionId) {
  try {
    const content = await _anoclaw.fs.read(file, sessionId);
    return { path: file, content: truncateText(content, 5000) };
  } catch (err) {
    return { path: file, error: err.message };
  }
}

async function safeGrepContext(term, glob, sessionId) {
  try {
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const raw = await _anoclaw.tools.execute('Grep', {
      pattern,
      path: '.',
      glob,
      output_mode: 'content',
      '-n': true,
      head_limit: 8,
    });
    return String(raw || '').split('\n').filter(Boolean).slice(0, 8).map(line => {
      const first = line.indexOf(':');
      const second = line.indexOf(':', first + 1);
      if (first < 0 || second < 0) return { file: line, line: 0, content: '' };
      return {
        file: line.slice(0, first),
        line: parseInt(line.slice(first + 1, second), 10) || 0,
        content: truncateText(line.slice(second + 1), 260),
      };
    });
  } catch {
    return [];
  }
}

async function collectProjectContext(meeting) {
  const startedAt = new Date().toISOString();
  const sessionId = meeting.sessionId || undefined;
  const explicitFiles = Array.isArray(meeting.contextFiles) ? meeting.contextFiles : [];
  const files = [...new Set([...DEFAULT_CONTEXT_FILES, ...explicitFiles])].slice(0, 12);
  const terms = extractContextTerms(meeting);
  const context = {
    generatedAt: startedAt,
    mode: meeting.contextEnabled === false ? 'disabled' : 'read-only-project-context',
    terms,
    files: [],
    grep: [],
    memories: [],
    errors: [],
  };

  if (meeting.contextEnabled === false) return context;

  for (const file of files) {
    const entry = await safeReadContextFile(file, sessionId);
    if (entry.error) context.errors.push(`read ${file}: ${entry.error}`);
    else context.files.push(entry);
  }

  const memoryQuery = meeting.contextQuery || [meeting.topic, meeting.goal, ...terms].filter(Boolean).join(' ');
  if (memoryQuery.trim()) {
    try {
      const memories = await _anoclaw.memory.search(memoryQuery, { scope: 'team', limit: 8, fuzzy: true });
      context.memories = (memories || []).map(m => ({
        name: m.name,
        type: m.type,
        description: m.description,
        content: truncateText(m.content || '', 1800),
      }));
    } catch (err) {
      context.errors.push(`memory search: ${err.message}`);
    }
  }

  for (const term of terms.slice(0, 4)) {
    for (const glob of CONTEXT_GREP_GLOBS.slice(0, 3)) {
      const matches = await safeGrepContext(term, glob, sessionId);
      if (matches.length > 0) context.grep.push({ term, glob, matches });
      if (context.grep.length >= 8) break;
    }
    if (context.grep.length >= 8) break;
  }

  return context;
}

function formatContextForPrompt(context) {
  if (!context || context.mode === 'disabled') {
    return 'Project context collection is disabled for this meeting.';
  }
  const lines = [
    'Read-only project context collected before the meeting. Refer to evidence IDs when making claims.',
  ];
  if (context.files?.length) {
    lines.push('\nFiles:');
    context.files.forEach((f, idx) => {
      lines.push(`[F${idx + 1}] ${f.path}\n${truncateText(f.content, 1600)}`);
    });
  }
  if (context.grep?.length) {
    lines.push('\nSearch hits:');
    context.grep.forEach((g, idx) => {
      const hits = g.matches.map(m => `${m.file}:${m.line}: ${m.content}`).join('\n');
      lines.push(`[G${idx + 1}] term="${g.term}" glob="${g.glob}"\n${truncateText(hits, 1200)}`);
    });
  }
  if (context.memories?.length) {
    lines.push('\nIndexed memories:');
    context.memories.forEach((m, idx) => {
      lines.push(`[M${idx + 1}] ${m.name} - ${m.description}\n${truncateText(m.content, 900)}`);
    });
  }
  if (context.errors?.length) {
    lines.push('\nContext collection warnings:\n' + context.errors.slice(0, 6).join('\n'));
  }
  return truncateText(lines.join('\n\n'), 12000);
}

// ── Meeting Templates ──

const TEMPLATES = [
  { id: 'daily-standup', name: 'Daily Standup', goal: 'Share progress, blockers, and plans for today', maxRounds: 1, speakerMode: 'round-robin', suggestion: 'Best for quick daily syncs (1 round, all participants)', category: 'Recurring', estimatedDuration: '10 min' },
  { id: 'sprint-planning', name: 'Sprint Planning', goal: 'Plan the upcoming sprint: select tasks, estimate effort, assign ownership', maxRounds: 2, speakerMode: 'round-robin', suggestion: 'Use 2 rounds - first for task proposals, second for refinement', category: 'Planning', estimatedDuration: '30 min' },
  { id: 'bug-triage', name: 'Bug Triage', goal: 'Review open bugs, classify severity, assign fix owners, set priority', maxRounds: 2, speakerMode: 'moderator', suggestion: 'Moderator mode - let one agent lead the triage process', category: 'Review', estimatedDuration: '25 min' },
  { id: 'retrospective', name: 'Retrospective', goal: 'Review what went well, what could improve, and define action items for next cycle', maxRounds: 3, speakerMode: 'round-robin', suggestion: '3 rounds: what went well, what to improve, action items', category: 'Recurring', estimatedDuration: '45 min' },
  { id: 'design-review', name: 'Design Review', goal: 'Review proposed architecture/design: identify risks, suggest improvements, align team', maxRounds: 2, speakerMode: 'round-robin', suggestion: 'First round for feedback, second for addressing concerns', category: 'Review', estimatedDuration: '30 min' },
  { id: 'incident-postmortem', name: 'Incident Postmortem', goal: 'Analyze what happened, root cause, impact, and action items to prevent recurrence', maxRounds: 3, speakerMode: 'moderator', suggestion: 'Moderator-led: timeline -> root cause -> prevention plan', category: 'Review', estimatedDuration: '60 min' },
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

const DEBATE_PHASES = {
  position: {
    label: 'Position framing',
    instruction: 'State a clear position, name the highest-leverage opportunity, and expose one assumption that could be wrong.',
  },
  challenge: {
    label: 'Adversarial challenge',
    instruction: 'Challenge a previous claim directly, name the tradeoff or failure mode, and offer a stronger alternative.',
  },
  synthesis: {
    label: 'Synthesis and commitment',
    instruction: 'Resolve the strongest disagreement, choose what should be done next, and define a verifiable checkpoint.',
  },
  forge: {
    label: 'Compressed forge',
    instruction: 'Give a compact position, challenge, synthesis, and implementation checkpoint in one turn.',
  },
};

// ── Meeting Orchestration @@
let _runningMeetings = new Set();
let _anoclaw = null;

function debatePhaseForTurn(meeting, round) {
  const maxRounds = Math.max(1, Number(meeting.maxRounds || 1));
  if (maxRounds === 1) return 'forge';
  if (round <= 1) return 'position';
  if (round >= maxRounds) return 'synthesis';
  return 'challenge';
}

function formatDebateLedgerForPrompt(meeting) {
  const ledger = meeting.debateLedger || [];
  if (!ledger.length) return 'No structured debate ledger yet.';
  return ledger.slice(-12).map(e => [
    `Round ${e.round} ${e.phase} ${e.speakerName || e.speakerId}`,
    e.position ? `Position: ${e.position}` : '',
    e.challenge ? `Challenge: ${e.challenge}` : '',
    e.decisionImpact ? `Decision impact: ${e.decisionImpact}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function formatToolBriefForPrompt(brief) {
  if (!brief || !brief.entries || brief.entries.length === 0) {
    return 'No additional tool evidence was collected for this turn.';
  }
  return brief.entries.map((e, idx) =>
    `[T${idx + 1}] ${e.toolName} purpose="${e.purpose || ''}" query="${e.query || ''}" params=${e.params || '{}'}\n${truncateText(e.summary || '', 900)}`
  ).join('\n\n');
}

function makeSysPrompt(meeting, speakerId, turnToolBrief = null) {
  const transcript = (meeting.transcript || []).map(t =>
    `[Round ${t.round} ${t.phase || ''}] ${resolveAgentName(t.speakerId)}: ${t.content}`
  ).join('\n\n');
  const isFirstSpeaker = (meeting.transcript || []).length === 0;
  const roleName = resolveAgentName(speakerId);
  const phaseKey = debatePhaseForTurn(meeting, meeting.currentRound || 1);
  const phase = DEBATE_PHASES[phaseKey] || DEBATE_PHASES.forge;
  const projectContext = formatContextForPrompt(meeting.contextBundle);
  const debateLedger = formatDebateLedgerForPrompt(meeting);
  const toolBrief = formatToolBriefForPrompt(turnToolBrief);
  const evidenceRule =
    `Use the project context as evidence. Cite evidence IDs like [F1], [G2], or [M1] when relevant. ` +
    `Use turn tool evidence IDs [T1], [T2] when relevant. ` +
    `Do not invent file contents or prior decisions. If evidence is missing, say what must be checked next. `;
  const outputContract =
    `Output exactly these labeled lines, each with substantive content:\n` +
    `Position: ...\n` +
    `Challenge: ...\n` +
    `Evidence: ...\n` +
    `Decision impact: ...\n` +
    `Next checkpoint: ...`;

  // First speaker needs an opening prompt
  if (isFirstSpeaker) {
    return [
      { role: 'system', content:
        `You are ${roleName}, a participant in a work meeting. Your goal is to help achieve the meeting objective. ` +
        `You have expertise relevant to the topic. Speak in first person as ${roleName}. ` +
        `This is the "${phase.label}" phase. ${phase.instruction} ` +
        evidenceRule +
        `Do not be agreeable by default: productive disagreement is required when a claim is weak. ` +
        outputContract + '\n' +
        `DO NOT say you are an AI. DO NOT repeat the instructions. Start your response NOW.` },
      { role: 'user', content:
        `Meeting: ${meeting.topic}\nGoal: ${meeting.goal}\nRound ${meeting.currentRound || 1}/${meeting.maxRounds}\nPhase: ${phase.label}\n\n` +
        `Project context:\n${projectContext}\n\nTurn tool evidence:\n${toolBrief}\n\n` +
        `Open the discussion with a sharp position grounded in evidence and one assumption that others should test. ` +
        `Speak as ${roleName} in first person. Your response: ` },
    ];
  }

  // Subsequent speakers
  return [
    { role: 'system', content:
      `You are ${roleName}, a participant in a work meeting. Your goal is to help achieve the meeting objective. ` +
      `Speak in first person as ${roleName}. ` +
      `This is the "${phase.label}" phase. ${phase.instruction} ` +
      evidenceRule +
      `You must create useful friction: challenge weak claims, expose tradeoffs, and converge only after resolving the strongest disagreement. ` +
      outputContract + '\n' +
      `Be specific and constructive. DO NOT say you are an AI. Respond NOW.` },
    { role: 'user', content:
      `Meeting: ${meeting.topic}\nGoal: ${meeting.goal}\nRound ${meeting.currentRound || 1}/${meeting.maxRounds}\nPhase: ${phase.label}\n\n` +
      `Project context:\n${projectContext}\n\n` +
      `Turn tool evidence:\n${toolBrief}\n\n` +
      `Structured debate ledger:\n${debateLedger}\n\n` +
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
    // Auto mode: adaptive - picks the participant with the fewest total contributions
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

function extractLabeledValue(content, label) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:\\s*(.+)$`, 'im');
  const match = String(content || '').match(re);
  return match ? truncateText(match[1].trim(), 700) : '';
}

function appendDebateLedger(meeting, entry) {
  const content = entry.content || '';
  const item = {
    round: entry.round,
    phase: entry.phase || debatePhaseForTurn(meeting, entry.round),
    speakerId: entry.speakerId,
    speakerName: entry.speakerName,
    position: extractLabeledValue(content, 'Position'),
    challenge: extractLabeledValue(content, 'Challenge'),
    evidence: extractLabeledValue(content, 'Evidence'),
    decisionImpact: extractLabeledValue(content, 'Decision impact'),
    nextCheckpoint: extractLabeledValue(content, 'Next checkpoint'),
    timestamp: entry.timestamp,
  };
  meeting.debateLedger = Array.isArray(meeting.debateLedger) ? meeting.debateLedger : [];
  meeting.debateLedger.push(item);
  if (meeting.debateLedger.length > 200) meeting.debateLedger = meeting.debateLedger.slice(-200);
}

function deriveOpenTensions(meeting) {
  const tensions = [];
  for (const item of meeting.debateLedger || []) {
    if (item.challenge) {
      tensions.push({
        round: item.round,
        speakerName: item.speakerName || item.speakerId,
        challenge: item.challenge,
        status: item.phase === 'synthesis' ? 'addressed-in-synthesis' : 'open',
      });
    }
  }
  return tensions.slice(-12);
}

function deriveDecisionRecords(meeting) {
  const records = [];
  for (const item of meeting.debateLedger || []) {
    if (!item.decisionImpact && !item.nextCheckpoint) continue;
    records.push({
      round: item.round,
      phase: item.phase,
      speakerName: item.speakerName || item.speakerId,
      decisionImpact: item.decisionImpact || '',
      nextCheckpoint: item.nextCheckpoint || '',
      evidence: item.evidence || '',
    });
  }
  return records.slice(-20);
}

function deriveContradictionMatrix(meeting) {
  const positions = (meeting.debateLedger || []).filter(d => d.position || d.challenge);
  const rows = [];
  for (const challenger of positions) {
    if (!challenger.challenge) continue;
    const challenged = positions.find(p =>
      p !== challenger &&
      p.position &&
      p.speakerId !== challenger.speakerId &&
      challenger.challenge.toLowerCase().split(/\W+/).some(token => token.length > 5 && p.position.toLowerCase().includes(token))
    );
    rows.push({
      challenger: challenger.speakerName || challenger.speakerId,
      target: challenged ? (challenged.speakerName || challenged.speakerId) : 'general',
      claim: challenged?.position || '',
      challenge: challenger.challenge,
      resolution: challenger.phase === 'synthesis' || challenger.phase === 'forge' ? 'addressed-late' : 'needs-resolution',
    });
  }
  return rows.slice(-16);
}

function assessPlanQuality(meeting, items) {
  const checks = [
    { id: 'summary', label: 'Durable summary generated', pass: !!meeting.summary },
    { id: 'actions', label: 'Action items extracted', pass: (items || []).length > 0 },
    { id: 'debate', label: 'Structured debate ledger captured', pass: (meeting.debateLedger || []).length > 0 },
    { id: 'friction', label: 'At least one explicit challenge recorded', pass: (meeting.debateLedger || []).some(d => !!d.challenge) },
    { id: 'evidence', label: 'Evidence or tool ledger captured', pass: !!meeting.contextBundle || (meeting.toolLedger || []).some(t => (t.entries || []).length > 0) },
    { id: 'decisions', label: 'Decision impact or checkpoint captured', pass: (meeting.debateLedger || []).some(d => !!d.decisionImpact || !!d.nextCheckpoint) },
  ];
  const passed = checks.filter(c => c.pass).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    checks,
    verdict: passed === checks.length ? 'ready-for-execution' : passed >= 4 ? 'usable-with-review' : 'needs-more-debate',
  };
}

function normalizeQualityThreshold(value) {
  const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 70;
  return Math.max(0, Math.min(100, parsed));
}

function normalizeComparableText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sameParticipants(a = [], b = []) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

async function findReusableMeeting(topic, goal, participantIds, options = {}) {
  await ensureDir();
  const files = await fs.promises.readdir(MEETINGS_DIR).catch(() => []);
  const topicKey = normalizeComparableText(topic);
  const goalKey = normalizeComparableText(goal);
  const now = Date.now();
  const recentMs = Math.max(0, Number(options.recentMs) || 30 * 60 * 1000);
  const candidates = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const m = JSON.parse(await fs.promises.readFile(path.join(MEETINGS_DIR, file), 'utf-8'));
      if (normalizeComparableText(m.topic) !== topicKey) continue;
      if (normalizeComparableText(m.goal) !== goalKey) continue;
      if (!sameParticipants(m.participantIds || [], participantIds || [])) continue;
      const ts = new Date(m.lastRunAt || m.createdAt || 0).getTime();
      if (m.status !== 'running' && m.status !== 'idle' && now - ts > recentMs) continue;
      candidates.push(m);
    } catch { /* ignore malformed meeting files */ }
  }
  candidates.sort((a, b) => new Date(b.lastRunAt || b.createdAt || 0).getTime() - new Date(a.lastRunAt || a.createdAt || 0).getTime());
  return candidates[0] || null;
}

function appendQualityRemediation(meeting, quality) {
  const missing = quality.checks.filter(check => !check.pass).map(check => check.label);
  if (!missing.length) return;
  const content = [
    'Position: The meeting plan is not yet strong enough for autonomous execution.',
    `Challenge: Missing quality gates: ${missing.join('; ')}.`,
    'Evidence: Plan Quality Gates found incomplete debate, evidence, decision, or action coverage.',
    'Decision impact: The executor must review and strengthen plan.md before implementation.',
    'Next checkpoint: Resolve every unchecked quality gate, then regenerate or update plan.md.',
  ].join('\n');
  const entry = {
    round: meeting.currentRound || meeting.maxRounds || 1,
    speakerId: 'quality-gate',
    speakerName: 'Quality Gate',
    phase: 'quality-gate',
    content,
    timestamp: new Date().toISOString(),
  };
  meeting.transcript = Array.isArray(meeting.transcript) ? meeting.transcript : [];
  meeting.transcript.push(entry);
  appendDebateLedger(meeting, entry);
}

async function collectTurnToolBrief(meeting, turn) {
  if (!_anoclaw || meeting.toolUseEnabled === false) return null;
  const phase = debatePhaseForTurn(meeting, turn.round);
  const terms = meeting.contextBundle?.terms || extractContextTerms(meeting);
  const query = [meeting.topic, meeting.goal, phase, terms[0] || ''].filter(Boolean).join(' ');
  const allowedTools = getMeetingAllowedToolSet(meeting);
  const budget = normalizeToolProbeBudget(meeting.toolProbeBudget);
  const brief = {
    round: turn.round,
    phase,
    speakerId: turn.speakerId,
    speakerName: resolveAgentName(turn.speakerId),
    generatedAt: new Date().toISOString(),
    allowedTools: Array.from(allowedTools),
    budget,
    entries: [],
  };

  const runProbe = async (toolName, params, meta = {}) => {
    if (brief.entries.length >= budget) return;
    if (!allowedTools.has(toolName)) return;
    const entry = await executeMeetingToolProbe(toolName, params, meta, {
      sessionId: meeting.sessionId || undefined,
      workspace: meeting.workspace || undefined,
      agentId: turn.speakerId,
      meetingId: meeting.id,
    });
    brief.entries.push(entry);
  };

  if (budget > 0) {
    await runProbe('memory.search', { query, scope: 'team', limit: 3, fuzzy: true }, { purpose: 'Find prior team memory relevant to the current debate turn.', query });
  }

  const grepTerm = terms[0] || String(meeting.topic || '').split(/\s+/).find(Boolean) || '';
  if (budget > 0 && grepTerm && /^[\p{L}\p{N}_-]{3,}$/u.test(grepTerm)) {
    const pattern = grepTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await runProbe('Grep', {
        pattern,
        path: '.',
        glob: 'plugins/**/*.{js,ts,json,html,md}',
        output_mode: 'content',
        '-n': true,
        head_limit: 5,
      }, { purpose: 'Find current workspace evidence matching the strongest context term.', query: grepTerm });
  }

  const templates = normalizeToolProbeTemplates(meeting.toolProbeTemplates, brief.allowedTools);
  for (const template of templates) {
    if (brief.entries.length >= budget) break;
    const params = fillProbeTemplateValue(template.params || {}, meeting, turn, terms);
    await runProbe(template.toolName, params, { purpose: template.purpose, query: params.query || params.pattern || params.url || params.path || '' });
  }

  meeting.toolLedger = Array.isArray(meeting.toolLedger) ? meeting.toolLedger : [];
  meeting.toolLedger.push(brief);
  if (meeting.toolLedger.length > 120) meeting.toolLedger = meeting.toolLedger.slice(-120);
  return brief;
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
      if (cols.every(c => /^[---─\s]+$/.test(c))) continue;
      // First column is typically the task description
      const task = cols[0] || '';
      if (!task || task.length < 5 || /^[---─\s]+$/.test(task)) continue;
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
  const projectContext = formatContextForPrompt(m.contextBundle);
  try {
    const resp = await _anoclaw.llm.chat([
      { role: 'system', content:
        'Write a durable project meeting record in Markdown. Include these exact sections: ' +
        '## Executive Summary, ## Evidence, ## Decisions, ## Implementation Plan, ## Risks, ## Action Items. ' +
        'Action items must be bullet points beginning with "- " and include owner, task, priority, and next checkpoint. ' +
        'Cite evidence IDs from the project context where relevant. Do not invent evidence.' },
      { role: 'user', content:
        `Meeting: ${m.topic}\nGoal: ${m.goal}\n\nProject context:\n${projectContext}\n\nTranscript:\n${transcript}\n\nWrite the durable record now.` },
    ], { maxTokens: 1800, temperature: 0.35 });
    return resp.content || 'Summary generation returned empty.';
  } catch (err) {
    console.error(`[meeting] Summary generation failed: ${err.message}`);
    return 'Summary generation failed.';
  }
}

function buildDecisionPlanMarkdown(m, summary, items) {
  const context = m.contextBundle || {};
  const evidenceLines = [];
  for (const [idx, f] of (context.files || []).entries()) {
    evidenceLines.push(`- [F${idx + 1}] ${f.path}`);
  }
  for (const [idx, g] of (context.grep || []).entries()) {
    evidenceLines.push(`- [G${idx + 1}] term="${g.term}" glob="${g.glob}" (${(g.matches || []).length} hits)`);
  }
  for (const [idx, mem] of (context.memories || []).entries()) {
    evidenceLines.push(`- [M${idx + 1}] ${mem.name}: ${mem.description || ''}`);
  }
  const debateLines = (m.debateLedger || []).map((d, idx) => [
    `### D${idx + 1}. Round ${d.round} - ${d.phase} - ${d.speakerName || d.speakerId}`,
    d.position ? `- Position: ${d.position}` : '',
    d.challenge ? `- Challenge: ${d.challenge}` : '',
    d.evidence ? `- Evidence: ${d.evidence}` : '',
    d.decisionImpact ? `- Decision impact: ${d.decisionImpact}` : '',
    d.nextCheckpoint ? `- Next checkpoint: ${d.nextCheckpoint}` : '',
  ].filter(Boolean).join('\n'));
  const tensions = deriveOpenTensions(m).map(t =>
    `- Round ${t.round} / ${t.speakerName}: ${t.challenge} (${t.status})`
  );
  const decisionRecords = deriveDecisionRecords(m).map((d, idx) => [
    `### DR${idx + 1}. Round ${d.round} - ${d.phase} - ${d.speakerName}`,
    d.decisionImpact ? `- Decision impact: ${d.decisionImpact}` : '',
    d.nextCheckpoint ? `- Next checkpoint: ${d.nextCheckpoint}` : '',
    d.evidence ? `- Evidence: ${d.evidence}` : '',
  ].filter(Boolean).join('\n'));
  const contradictions = deriveContradictionMatrix(m).map((row, idx) => [
    `### C${idx + 1}. ${row.challenger} -> ${row.target}`,
    row.claim ? `- Claim: ${row.claim}` : '',
    `- Challenge: ${row.challenge}`,
    `- Resolution: ${row.resolution}`,
  ].filter(Boolean).join('\n'));
  const toolLines = (m.toolLedger || []).flatMap((turn, turnIdx) =>
    (turn.entries || []).map((entry, idx) =>
      `- [TL${turnIdx + 1}.${idx + 1}] Round ${turn.round} ${turn.phase} ${turn.speakerName}: ${entry.toolName} purpose="${entry.purpose || ''}" query="${entry.query || ''}" params=${entry.params || '{}'} duration=${entry.durationMs || 0}ms - ${truncateText(entry.summary || '', 260).replace(/\n/g, ' ')}`
    )
  );
  const toolPolicyLines = [
    `- Enabled: ${m.toolUseEnabled !== false}`,
    `- Allowed tools: ${normalizeAllowedToolNames(m.allowedToolNames).join(', ')}`,
    `- Probe budget per turn: ${normalizeToolProbeBudget(m.toolProbeBudget)}`,
    `- Configured probe templates: ${(normalizeToolProbeTemplates(m.toolProbeTemplates, m.allowedToolNames) || []).length}`,
  ];
  const quality = assessPlanQuality(m, items || []);
  const qualityLines = [
    `- Verdict: ${quality.verdict}`,
    `- Score: ${quality.score}/100`,
    ...quality.checks.map(check => `- [${check.pass ? 'x' : ' '}] ${check.label}`),
  ];

  return [
    `# Meeting Plan: ${m.topic}`,
    '',
    `Meeting ID: ${m.id}`,
    `Goal: ${m.goal}`,
    `Status: ${m.status}`,
    `Generated: ${new Date().toISOString()}`,
    `Plan File: data/meetings/plans/${m.id}/plan.md`,
    '',
    '## Index Keywords',
    [m.topic, m.goal, ...(context.terms || [])].filter(Boolean).join(', '),
    '',
    '## Evidence Index',
    evidenceLines.length ? evidenceLines.join('\n') : '- No project evidence collected.',
    '',
    '## Durable Summary',
    summary || 'No summary generated.',
    '',
    '## Debate Ledger',
    debateLines.length ? debateLines.join('\n\n') : '- No structured debate ledger recorded.',
    '',
    '## Open Tensions',
    tensions.length ? tensions.join('\n') : '- No unresolved tensions recorded.',
    '',
    '## Decision Records',
    decisionRecords.length ? decisionRecords.join('\n\n') : '- No decision records extracted.',
    '',
    '## Contradiction Matrix',
    contradictions.length ? contradictions.join('\n\n') : '- No explicit contradictions recorded.',
    '',
    '## Tool Ledger',
    toolPolicyLines.join('\n'),
    '',
    toolLines.length ? toolLines.join('\n') : '- No meeting-time tool calls recorded.',
    '',
    '## Plan Quality Gates',
    qualityLines.join('\n'),
    '',
    '## Normalized Action Items',
    (items || []).length
      ? items.map(item => `- [ ] ${item.task} | owner: ${item.assignee || 'unassigned'} | priority: ${item.priority || 'medium'} | status: ${item.status || 'pending'}`).join('\n')
      : '- No action items extracted.',
    '',
    '## Execution Contract',
    '- Treat this file as the source of truth for follow-up implementation.',
    '- Before executing, verify cited evidence and update this plan if reality differs.',
    '- Keep checkboxes and status fields current as work progresses.',
    '- Record major implementation decisions back into this file or a linked session note.',
  ].join('\n');
}

async function persistDecisionPlanFile(m) {
  const content = m.decisionPlan || buildDecisionPlanMarkdown(m, m.summary, m.actionItems || []);
  const dir = await ensurePlanDir(m.id);
  const planPath = path.join(dir, 'plan.md');
  await fs.promises.writeFile(planPath, content, 'utf-8');
  return {
    path: path.relative(process.cwd(), planPath).replace(/\\/g, '/'),
    absolutePath: planPath,
    updatedAt: new Date().toISOString(),
  };
}

async function ensureDecisionPlan(m) {
  if (!m) return null;
  if (!m.decisionPlan) {
    m.decisionPlan = buildDecisionPlanMarkdown(m, m.summary || '', m.actionItems || []);
  }
  m.planFile = await persistDecisionPlanFile(m);
  await saveMeeting(m, broadcastUpdate);
  return m;
}

function buildPlanExecutionPrompt(m) {
  const planPath = m.planFile?.path || `data/meetings/plans/${m.id}/plan.md`;
  return [
    `Execute the durable meeting plan from ${planPath}.`,
    '',
    `Meeting: ${m.topic}`,
    `Meeting ID: ${m.id}`,
    `Goal: ${m.goal}`,
    '',
    'Required workflow:',
    '1. Read the plan.md file first and treat it as the source of truth.',
    '2. Verify the cited evidence before making changes or assignments.',
    '3. Convert the Normalized Action Items into TodoWrite tasks.',
    '4. Execute the plan incrementally, updating plan.md checkboxes/status as work completes.',
    '5. If the plan is incomplete or evidence contradicts it, revise plan.md before continuing.',
    '6. Report progress back to this session with links to changed files and remaining risks.',
  ].join('\n');
}

async function createExecutionSessionForMeeting(meeting, options = {}) {
  const updated = await ensureDecisionPlan(meeting);
  const body = { title: options.title || `Execute meeting plan: ${updated.topic}` };
  if (options.agentId) body.agentId = options.agentId;
  const result = await _anoclaw.api.call('POST', '/api/v1/sessions', body);
  if (result.statusCode >= 400) {
    return {
      ok: false,
      statusCode: result.statusCode,
      detail: result.body,
      meeting: updated,
      executionPrompt: buildPlanExecutionPrompt(updated),
    };
  }

  const executionPrompt = buildPlanExecutionPrompt(updated);
  const run = {
    sessionId: result.body.id,
    createdAt: new Date().toISOString(),
    agentId: result.body.agentId || options.agentId || null,
    autoDispatch: options.autoDispatch === true,
    dispatchStatus: 'not-requested',
  };

  let dispatch = null;
  if (options.autoDispatch === true) {
    try {
      const send = await _anoclaw.api.call('POST', `/api/v1/sessions/${result.body.id}/messages`, {
        content: executionPrompt,
        mode: options.mode || 'auto',
        effort: options.effort !== false,
      });
      dispatch = {
        statusCode: send.statusCode,
        body: send.body,
        accepted: send.statusCode >= 200 && send.statusCode < 300,
      };
      run.dispatchStatus = dispatch.accepted ? 'accepted' : 'failed';
      run.dispatchDetail = dispatch.body || null;
    } catch (err) {
      dispatch = { accepted: false, error: err.message };
      run.dispatchStatus = 'failed';
      run.dispatchDetail = { error: err.message };
    }
  }

  updated.executionSessions = Array.isArray(updated.executionSessions) ? updated.executionSessions : [];
  updated.executionSessions.push(run);
  await saveMeeting(updated, broadcastUpdate);
  return {
    ok: true,
    meeting: updated,
    session: result.body,
    planFile: updated.planFile,
    executionPrompt,
    dispatch,
    executionRun: run,
  };
}

async function waitForMeetingToFinish(meetingId, waitTimeoutMs) {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const m = await getMeeting(meetingId);
    if (!m) return { result: 'missing', meeting: null };
    if (m.status !== 'running') return { result: 'done', meeting: m };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { result: 'timeout', meeting: await getMeeting(meetingId) };
}

async function runAndMaybeReturnMeetingPlan(meetingId, opts) {
  const waitTimeoutMs = Math.max(1000, Math.min(900000, parseInt(opts.waitTimeoutMs) || 300000));
  const loopPromise = runMeetingLoop(meetingId).catch(err => {
    if (_anoclaw) _anoclaw.log.error(`Meeting ${meetingId}: ${err.message}`);
  });
  const waitResult = await waitForMeetingToFinish(meetingId, waitTimeoutMs);
  await Promise.race([loopPromise, Promise.resolve()]);
  const latest = waitResult.meeting || await getMeeting(meetingId);
  if (waitResult.result === 'timeout') {
    return [
      `Meeting still running after ${waitTimeoutMs}ms: ${meetingId}`,
      `Topic: ${latest?.topic || ''}`,
      `Goal: ${latest?.goal || ''}`,
      `Mode: ${latest?.speakerMode || ''}, Rounds: ${latest?.maxRounds || ''}`,
      `Status: ${latest?.status || 'unknown'}`,
      `Transcript turns: ${(latest?.transcript || []).length}`,
      `Call MeetingGetPlan with meetingId="${meetingId}" once the meeting completes.`,
    ].join('\n');
  }
  if (!latest) return `Meeting ${meetingId} finished but could not be loaded from storage.`;
  const completed = opts.returnPlan ? await ensureDecisionPlan(latest) : latest;
  if (!completed) return `Meeting ${meetingId} finished but could not be loaded from storage.`;
  return opts.returnPlan ? formatMeetingPlanResult(completed) : [
    `Meeting completed: ${meetingId}`,
    `Topic: ${completed.topic}`,
    `Goal: ${completed.goal}`,
    `Participants: ${(completed.participantIds || []).map(id => resolveAgentName(id)).join(', ')}`,
    `Mode: ${completed.speakerMode}, Rounds: ${completed.maxRounds}`,
    `Status: ${completed.status || 'completed'}`,
    `Plan file: ${completed.planFile?.path || `data/meetings/plans/${meetingId}/plan.md`}`,
  ].join('\n');
}

function formatMeetingPlanResult(m) {
  const planPath = m.planFile?.path || `data/meetings/plans/${m.id}/plan.md`;
  const actions = (m.actionItems || []).map(item =>
    `- ${item.task} | owner: ${item.assignee || 'unassigned'} | priority: ${item.priority || 'medium'} | status: ${item.status || 'pending'}`
  );
  const quality = assessPlanQuality(m, m.actionItems || []);
  return [
    `Meeting completed: ${m.id}`,
    `Topic: ${m.topic}`,
    `Goal: ${m.goal}`,
    `Status: ${m.status}`,
    `Plan file: ${planPath}`,
    `Transcript turns: ${(m.transcript || []).length}`,
    `Action items: ${(m.actionItems || []).length}`,
    `Plan quality: ${quality.verdict} (${quality.score}/100)`,
    '',
    'Execution prompt:',
    buildPlanExecutionPrompt(m),
    '',
    'Action items:',
    actions.length ? actions.join('\n') : '- No action items extracted.',
    '',
    'Plan content:',
    m.decisionPlan || '',
  ].join('\n');
}

async function saveToMemory(m, summary, items) {
  if (!_anoclaw) return;
  const decisionPlan = buildDecisionPlanMarkdown(m, summary, items);
  // Save summary
  if (summary) {
    try {
      await _anoclaw.memory.save({
        name: `meeting-summary-${m.id}`,
        type: 'reference',
        description: `Meeting summary: ${m.topic}`,
        content: decisionPlan,
        scope: 'team',
      });
    } catch (err) {
      console.error(`[meeting] Failed to save summary to memory: ${err.message}`);
    }
  }
  try {
    await _anoclaw.memory.save({
      name: `meeting-plan-${m.id}`,
      type: 'project',
      description: `Durable project plan from meeting "${m.topic}"`,
      content: decisionPlan,
      scope: 'team',
    });
  } catch (err) {
    console.error(`[meeting] Failed to save decision plan to memory: ${err.message}`);
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

      if (m.contextEnabled !== false && !m.contextBundle) {
        _anoclaw.log.info(`Meeting ${meetingId}: collecting read-only project context`);
        m.contextBundle = await collectProjectContext(m);
        await saveMeeting(m, broadcastUpdate);
      }

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
          let quality = assessPlanQuality(m, m.actionItems);
          const threshold = normalizeQualityThreshold(m.minimumQualityScore);
          if (m.enforceQualityGate !== false && quality.score < threshold) {
            appendQualityRemediation(m, quality);
            quality = assessPlanQuality(m, m.actionItems);
          }
          m.planQuality = quality;
          m.decisionPlan = buildDecisionPlanMarkdown(m, summary, m.actionItems);
          m.planFile = await persistDecisionPlanFile(m);
          m.analytics = computeSpeakerAnalytics(m);
          m.duration = computeDuration(m);
          await saveToMemory(m, summary, m.actionItems);
        } catch (err) { _anoclaw.log.error(`Meeting ${meetingId} post-processing: ${err.message}`); }
        m.status = 'completed'; m.endedAt = new Date().toISOString();
        m.duration = computeDuration(m);
        await saveMeeting(m, broadcastUpdate);
        break;
      }

      const next = getNextSpeaker(m);
      if (!next) break;
      m.currentRound = next.round;
      const phase = debatePhaseForTurn(m, next.round);
      const turnToolBrief = await collectTurnToolBrief(m, next);

      try {
        _anoclaw.log.info(`Meeting ${meetingId}: ${resolveAgentName(next.speakerId)} R${next.round}`);
        let respContent = '';
        const resp = await _anoclaw.llm.chat(makeSysPrompt(m, next.speakerId, turnToolBrief), { maxTokens: 1200, temperature: 0.72 });
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

        const transcriptEntry = {
          round: next.round, speakerId: next.speakerId, speakerName: resolveAgentName(next.speakerId),
          phase, content: respContent, timestamp: new Date().toISOString(),
        };
        m.transcript.push(transcriptEntry);
        appendDebateLedger(m, transcriptEntry);
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
    { method: 'GET', path: '/api/v1/meetings/:id/plan', handler: 'handleGetPlan' },
    { method: 'POST', path: '/api/v1/meetings/:id/plan/session', handler: 'handleCreatePlanSession' },
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
        meetingStyle: { type: 'string', enum: ['dialectic', 'workshop'], description: 'dialectic forces position/challenge/synthesis. Default: dialectic.' },
        toolUseEnabled: { type: 'boolean', description: 'Allow the meeting loop to collect read-only tool evidence before turns. Default: true.' },
        allowedToolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit meeting probe tool allowlist. Defaults to memory.search and Grep. Add read-only native/plugin tools only when their params are provided in toolProbeTemplates.',
        },
        toolProbeBudget: { type: 'number', description: 'Maximum tool probes per participant turn, 0-6. Default: 2.' },
        toolProbeTemplates: {
          type: 'array',
          description: 'Optional explicit tool probes for native/plugin tools. Params can use {{topic}}, {{goal}}, {{phase}}, {{round}}, {{speakerId}}, {{speakerName}}, {{term}}, {{terms}}.',
          items: {
            type: 'object',
            properties: {
              toolName: { type: 'string' },
              purpose: { type: 'string' },
              params: { type: 'object' },
            },
            required: ['toolName', 'params'],
          },
        },
        contextEnabled: { type: 'boolean', description: 'Collect read-only project context before discussion. Default: true.' },
        contextQuery: { type: 'string', description: 'Optional query for memory/code context collection.' },
        contextFiles: { type: 'array', items: { type: 'string' }, description: 'Optional extra workspace files to read as meeting evidence.' },
        waitForCompletion: { type: 'boolean', description: 'If true, wait for the meeting to finish before returning. Use this in autonomous session workflows.' },
        returnPlan: { type: 'boolean', description: 'If true, return the durable plan.md content and execution prompt after completion. Implies waitForCompletion.' },
        background: { type: 'boolean', description: 'Run in background and return immediately. Default: false for tool calls so agents get plan.md instead of launching duplicate meetings.' },
        forceNew: { type: 'boolean', description: 'Create a new meeting even if an equivalent running/recent meeting exists. Default: false.' },
        waitTimeoutMs: { type: 'number', description: 'Maximum wait time for waitForCompletion/returnPlan. Default: 300000, max: 900000.' },
        minimumQualityScore: { type: 'number', description: 'Minimum plan quality score, 0-100. Default: 70.' },
        enforceQualityGate: { type: 'boolean', description: 'If true, append remediation notes when quality is below threshold. Default: true.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['topic', 'goal', 'participantIds'],
    },
    category: 'Coordination',
  });

  // Read-only participant tools - available during meetings for context gathering
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
    name: 'MeetingGetPlan',
    description: 'Get or generate the durable plan.md for a completed or in-progress meeting. Returns the plan path, plan content, and execution prompt.',
    parametersSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID, for example meet_abcd123.' },
        sessionId: { type: 'string', description: 'Optional session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['meetingId'],
    },
    category: 'Meeting',
  });

  await anoclaw.tools.register({
    name: 'MeetingStartPlanSession',
    description: 'Create a new AnoClaw session for executing a meeting-generated plan.md. Returns the new session and the exact execution prompt to send there.',
    parametersSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Meeting ID whose plan should be executed.' },
        agentId: { type: 'string', description: 'Optional agent ID for the new execution session.' },
        title: { type: 'string', description: 'Optional title for the execution session.' },
        autoDispatch: { type: 'boolean', description: 'Try to send the execution prompt into the new session immediately. Requires the target session WebSocket/API pipeline to accept messages.' },
        mode: { type: 'string', enum: ['auto', 'manual', 'plan'], description: 'Message mode for autoDispatch. Default: auto.' },
        effort: { type: 'boolean', description: 'Effort flag for autoDispatch. Default: true.' },
        sessionId: { type: 'string', description: 'Optional caller session identifier for context tracking.' },
        workspace: { type: 'string', description: 'Optional workspace path for context tracking.' },
      },
      required: ['meetingId'],
    },
    category: 'Coordination',
  });

  await anoclaw.tools.register({
    name: 'MeetingWebSearch',
    description: 'Search the web for information. Uses the built-in WebSearch tool if available. Returns search results as text.',
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
    '## Meeting Tool Guidance\n' +
    '- Use LaunchMeeting for structured multi-agent deliberation, critique, synthesis, or durable plan generation.\n' +
    '- LaunchMeeting is expensive coordination. Call it once per topic unless forceNew=true is explicitly justified.\n' +
    '- For autonomous work, prefer waitForCompletion/returnPlan so the caller receives the final plan and execution prompt.\n' +
    '- Use background=true only when the user wants the meeting to continue in the Meet tab without blocking the current session.\n' +
    '- Use MeetingGetPlan to retrieve the durable plan.md, and MeetingStartPlanSession to create an execution session for that plan.\n' +
    '- Meeting tools can gather read-only evidence; keep probes bounded and recorded in the plan Tool Ledger.\n' +
    '- Integrate meeting output yourself before reporting to the user; do not hand back raw discussion when a decision or plan is needed.\n',
    45
  );

  const meetingSummary = await listMeetings({ page: 1, limit: 100 });
  const runningCount = meetingSummary.meetings.filter(m => m.status === 'running').length;
  await mountSlotBadge(
    anoclaw,
    'Meet',
    `${runningCount}/${meetingSummary.pagination.total} running`,
    runningCount > 0 ? 'info' : 'ok',
    'meeting-status',
    52,
  );

  return [{ dispose() { deactivate(); } }];
}

export async function deactivate() {
  for (const id of _runningMeetings) _runningMeetings.delete(id);
  if (_anoclaw) {
    _anoclaw.log.info('Meeting plugin deactivated');
    await _anoclaw.prompt.inject('meeting-tool-instructions', '');
    await _anoclaw.ui?.unmountAll('titlebar-right');
  }
}

// ── HTTP Handlers ──

async function mountSlotBadge(anoclaw, label, value, tone, id, priority = 50) {
  const html = `<span class="anoclaw-slot-pill" data-tone="${tone}"><span class="slot-dot"></span><strong>${escapeSlot(label)}</strong><span>${escapeSlot(value)}</span></span>`;
  await anoclaw.ui?.mount('titlebar-right', html, { id, priority, position: 'append', replace: true });
}

function escapeSlot(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    meetingStyle: body.meetingStyle || 'dialectic',
    toolUseEnabled: body.toolUseEnabled !== false,
    allowedToolNames: normalizeAllowedToolNames(body.allowedToolNames),
    toolProbeBudget: normalizeToolProbeBudget(body.toolProbeBudget),
    toolProbeTemplates: normalizeToolProbeTemplates(body.toolProbeTemplates, body.allowedToolNames),
    minimumQualityScore: normalizeQualityThreshold(body.minimumQualityScore),
    enforceQualityGate: body.enforceQualityGate !== false,
    contextEnabled: body.contextEnabled !== false,
    contextQuery: body.contextQuery || '',
    contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles : [],
    contextBundle: null, decisionPlan: null,
    debateLedger: [], toolLedger: [],
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
  const updatableFields = ['topic', 'goal', 'speakerMode', 'maxRounds', 'moderatorId', 'autoExecute', 'allowInterjection', 'participantIds', 'meetingStyle', 'toolUseEnabled', 'allowedToolNames', 'toolProbeBudget', 'toolProbeTemplates', 'minimumQualityScore', 'enforceQualityGate', 'contextEnabled', 'contextQuery', 'contextFiles'];
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
      } else if (field === 'contextFiles') {
        if (!Array.isArray(body[field])) return { status: 400, body: { error: 'contextFiles must be an array of file paths' } };
        m.contextFiles = body[field].slice(0, 12);
        m.contextBundle = null;
      } else if (field === 'allowedToolNames') {
        if (!Array.isArray(body[field])) return { status: 400, body: { error: 'allowedToolNames must be an array of tool names' } };
        m.allowedToolNames = normalizeAllowedToolNames(body[field]);
        m.toolProbeTemplates = normalizeToolProbeTemplates(m.toolProbeTemplates, m.allowedToolNames);
      } else if (field === 'toolProbeBudget') {
        m.toolProbeBudget = normalizeToolProbeBudget(body[field]);
      } else if (field === 'minimumQualityScore') {
        m.minimumQualityScore = normalizeQualityThreshold(body[field]);
      } else if (field === 'enforceQualityGate') {
        m.enforceQualityGate = body[field] !== false;
      } else if (field === 'toolProbeTemplates') {
        if (!Array.isArray(body[field])) return { status: 400, body: { error: 'toolProbeTemplates must be an array' } };
        m.toolProbeTemplates = normalizeToolProbeTemplates(body[field], m.allowedToolNames);
      } else {
        m[field] = body[field];
        if (field === 'topic' || field === 'goal' || field === 'contextQuery' || field === 'contextEnabled') m.contextBundle = null;
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

  m.status = 'running'; m.transcript = []; m.actionItems = []; m.summary = null; m.decisionPlan = null; m.planFile = null; m.debateLedger = []; m.toolLedger = []; m.contextBundle = null;
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
      for (const item of m.actionItems) text += `  [${item.status||'pending'}] ${item.task} - ${item.assignee} (${item.priority})\\n`;
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
  if (m.debateLedger?.length) {
    text += `---\\n## Debate Ledger\\n`;
    for (const d of m.debateLedger) {
      text += `### Round ${d.round} - ${d.phase} - ${d.speakerName || d.speakerId}\\n`;
      if (d.position) text += `- Position: ${d.position}\\n`;
      if (d.challenge) text += `- Challenge: ${d.challenge}\\n`;
      if (d.evidence) text += `- Evidence: ${d.evidence}\\n`;
      if (d.decisionImpact) text += `- Decision impact: ${d.decisionImpact}\\n`;
      text += `\\n`;
    }
  }
  if (m.toolLedger?.length) {
    text += `---\\n## Tool Ledger\\n`;
    text += `Allowed tools: ${normalizeAllowedToolNames(m.allowedToolNames).join(', ')}\\n`;
    text += `Probe budget per turn: ${normalizeToolProbeBudget(m.toolProbeBudget)}\\n\\n`;
    for (const turn of m.toolLedger) {
      for (const entry of turn.entries || []) {
        text += `- Round ${turn.round} ${turn.phase} ${turn.speakerName}: ${entry.toolName} purpose="${entry.purpose || ''}" query="${entry.query || ''}" params=${entry.params || '{}'} duration=${entry.durationMs || 0}ms\\n`;
      }
    }
    text += `\\n`;
  }
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

export async function handleGetPlan(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };

  const updated = await ensureDecisionPlan(m);
  return {
    status: 200,
    body: {
      meetingId: updated.id,
      topic: updated.topic,
      status: updated.status,
      plan: updated.decisionPlan,
      planFile: updated.planFile,
      executionPrompt: buildPlanExecutionPrompt(updated),
    },
  };
}

export async function handleCreatePlanSession(req) {
  const id = req.params?.id || (req.path || '').split('/meetings/')[1]?.split('/')[0];
  const m = await getMeeting(id);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  if (!_anoclaw) return { status: 503, body: { error: 'Plugin not activated' } };

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const created = await createExecutionSessionForMeeting(m, body);
  if (!created.ok) {
    return {
      status: created.statusCode,
      body: {
        error: 'Session creation failed',
        detail: created.detail,
        executionPrompt: created.executionPrompt,
      },
    };
  }

  return {
    status: 201,
    body: {
      meetingId: created.meeting.id,
      session: created.session,
      planFile: created.planFile,
      executionPrompt: created.executionPrompt,
      dispatch: created.dispatch,
      executionRun: created.executionRun,
    },
  };
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
  'WebSearch', 'WebFetch',
  'memory_search', 'memory_list',
  'session_search',
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
      await refreshAgentCache(_anoclaw);
      const result = await _anoclaw.api.call('GET', '/api/v1/agents');
      return `Available agents:\n${JSON.stringify(result.body?.agents || [], null, 2)}`;
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
  if (toolName === 'MeetingGetPlan') {
    const meetingId = (params.meetingId || params.id || '').trim();
    if (!meetingId) return 'Error: meetingId parameter is required.';
    try {
      const meeting = await getMeeting(meetingId);
      if (!meeting) return `Error: meeting not found: ${meetingId}`;
      const updated = await ensureDecisionPlan(meeting);
      return [
        `Meeting plan ready: ${updated.id}`,
        `Topic: ${updated.topic}`,
        `Status: ${updated.status}`,
        `Plan file: ${updated.planFile?.path || `data/meetings/plans/${updated.id}/plan.md`}`,
        '',
        'Execution prompt:',
        buildPlanExecutionPrompt(updated),
        '',
        'Plan content:',
        updated.decisionPlan,
      ].join('\n');
    } catch (err) {
      return `Error loading meeting plan: ${err.message}`;
    }
  }

  if (toolName === 'MeetingStartPlanSession') {
    const meetingId = (params.meetingId || params.id || '').trim();
    if (!meetingId) return 'Error: meetingId parameter is required.';
    try {
      const meeting = await getMeeting(meetingId);
      if (!meeting) return `Error: meeting not found: ${meetingId}`;
      const created = await createExecutionSessionForMeeting(meeting, params);
      if (!created.ok) {
        return [
          `Error creating execution session: HTTP ${created.statusCode}`,
          JSON.stringify(created.detail || {}, null, 2),
          '',
          'You can still execute manually with this prompt:',
          created.executionPrompt,
        ].join('\n');
      }
      return [
        `Execution session created: ${created.session.id}`,
        `Agent: ${created.session.agentId || 'auto-selected'}`,
        `Plan file: ${created.planFile?.path || `data/meetings/plans/${created.meeting.id}/plan.md`}`,
        `Auto dispatch: ${created.dispatch ? (created.dispatch.accepted ? 'accepted' : 'failed') : 'not-requested'}`,
        '',
        created.dispatch?.accepted ? 'The execution prompt was accepted by the target session.' : 'Send this execution prompt in the new session:',
        created.executionPrompt,
      ].join('\n');
    } catch (err) {
      return `Error creating plan execution session: ${err.message}`;
    }
  }

  if (toolName === 'MeetingWebSearch') {
    const query = (params.query || '').trim();
    if (!query) return 'Error: query parameter is required.';
    try {
      if (!ALLOWED_BUILTIN_TOOLS.has('WebSearch')) {
        return 'Error: Tool "WebSearch" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('WebSearch', { query }, ctx);
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
      if (!ALLOWED_BUILTIN_TOOLS.has('WebFetch')) {
        return 'Error: Tool "WebFetch" is not allowed for meeting participants. Only read-only, memory, and web tools are permitted.';
      }
      const result = await _anoclaw.tools.execute('WebFetch', { url }, ctx);
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

  let topic = params.topic, goal = params.goal, mode = params.speakerMode || 'round-robin', rounds = params.maxRounds || 2;
  if (params.template) {
    const tmpl = TEMPLATES.find(t => t.id === params.template);
    if (tmpl) { if (!topic) topic = tmpl.name; if (!goal) goal = tmpl.goal; if (!mode) mode = tmpl.speakerMode; if (!rounds) rounds = tmpl.maxRounds; }
  }

  const background = params.background === true;
  const waitForCompletion = params.waitForCompletion === true || params.returnPlan === true || mode === 'auto' || !background;
  const returnPlan = params.returnPlan !== false && waitForCompletion;
  const waitTimeoutMs = Math.max(1000, Math.min(900000, parseInt(params.waitTimeoutMs) || 300000));

  if (params.forceNew !== true) {
    const reusable = await findReusableMeeting(topic, goal, pIds);
    if (reusable) {
      if (reusable.status === 'idle') {
        reusable.status = 'running';
        reusable.lastRunAt = new Date().toISOString();
        await saveMeeting(reusable, broadcastUpdate);
      }
      if (waitForCompletion) {
        const result = await runAndMaybeReturnMeetingPlan(reusable.id, { waitTimeoutMs, returnPlan });
        return [`Reused existing meeting: ${reusable.id}`, result].join('\n');
      }
      return [
        `Reused existing meeting: ${reusable.id}`,
        `Topic: ${reusable.topic}`,
        `Goal: ${reusable.goal}`,
        `Status: ${reusable.status}`,
        `Transcript turns: ${(reusable.transcript || []).length}`,
        `Use forceNew=true only if you intentionally need a separate meeting.`,
      ].join('\n');
    }
  }

  const id = `meet_${Date.now().toString(36)}`;
  const data = {
    id, topic, goal, status: 'idle', createdAt: new Date().toISOString(), lastRunAt: null, endedAt: null,
    participantIds: pIds, speakerMode: mode, moderatorId: mode === 'moderator' ? pIds[0] : null, maxRounds: rounds,
    autoExecute: false, allowInterjection: true,
    meetingStyle: params.meetingStyle || 'dialectic',
    toolUseEnabled: params.toolUseEnabled !== false,
    allowedToolNames: normalizeAllowedToolNames(params.allowedToolNames),
    toolProbeBudget: normalizeToolProbeBudget(params.toolProbeBudget),
    toolProbeTemplates: normalizeToolProbeTemplates(params.toolProbeTemplates, params.allowedToolNames),
    minimumQualityScore: normalizeQualityThreshold(params.minimumQualityScore),
    enforceQualityGate: params.enforceQualityGate !== false,
    contextEnabled: params.contextEnabled !== false,
    contextQuery: params.contextQuery || '',
    contextFiles: Array.isArray(params.contextFiles) ? params.contextFiles : [],
    sessionId: params.sessionId || null,
    workspace: params.workspace || null,
    contextBundle: null, decisionPlan: null,
    debateLedger: [], toolLedger: [],
    transcript: [], actionItems: [], summary: null, currentRound: 0, seq: 0, template: params.template || null,
  };
  await saveMeeting(data, broadcastUpdate);

  data.status = 'running'; data.lastRunAt = new Date().toISOString();
  await saveMeeting(data, broadcastUpdate);

  if (waitForCompletion) {
    return await runAndMaybeReturnMeetingPlan(id, { waitTimeoutMs, returnPlan });
  }

  runMeetingLoop(id).catch(err => { if (_anoclaw) _anoclaw.log.error(`Meeting ${id}: ${err.message}`); });

  return [
    `Meeting created: ${id}`,
    `Topic: ${topic}`, `Goal: ${goal}`,
    `Participants: ${names.join(', ')}`,
    `Mode: ${mode}, Rounds: ${rounds}`,
    `Plan handoff: after completion, call MeetingGetPlan with meetingId="${id}" to retrieve data/meetings/plans/${id}/plan.md and the execution prompt.`,
    `Status: running now - check the Meet tab for live updates`,
  ].join('\n');
}
