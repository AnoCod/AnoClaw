import type { ToolActivityState } from './ToolActivityDelegate.js';

/**
 * Tool metadata registry: verb phrase + result-summary extractor for every known tool.
 * Unknown tools get a generated verb from their camelCase name.
 */
export const TOOL_REGISTRY: Record<string, { verb: string; result: (t: ToolActivityState) => string | null }> = {
  // ── File tools ──
  Read:   { verb: 'read',   result: t => { const c = t.result || ''; if (c.startsWith('[Image')) return 'Image file'; return `${c.split('\n').length} lines`; } },
  Write:  { verb: 'wrote',  result: t => { const c = t.result || ''; const m = c.match(/Successfully wrote (\d+) chars to (.+)/); const path = m?.[2]?.replace(/\\/g, '/').split('/').pop(); return `Wrote ${m?.[1] || '?'} chars` + (path ? ` → ${path}` : ''); } },
  Edit:   { verb: 'edited', result: () => null },
  Grep:   { verb: 'searched', result: t => { const c = t.result || ''; if (!c || c === '(no matches)') return 'No matches'; return `${c.split('\n').filter(Boolean).length} matches`; } },
  Glob:   { verb: 'found',  result: t => { const c = t.result || ''; if (!c || c === '(no matches)') return 'Nothing found'; return `${c.split('\n').filter(Boolean).length} files`; } },
  Bash:   { verb: 'ran',    result: t => { const c = (t.result || '').trim(); if (!c) return 'Done'; return c.length > 80 ? `${c.split('\n').length} lines output` : c; } },
  // ── Web tools ──
  WebSearch: { verb: 'searched', result: t => { const n = ((t.result || '').match(/\[.+\]\(https?:\/\//g) || []).length; return n ? `${n} results` : 'Done'; } },
  WebFetch:  { verb: 'fetched',  result: t => `Read ${(t.result || '').length} chars` },
  ApiCall:   { verb: 'called',   result: t => { const c = (t.result || '').trim(); return c ? `${c.length} chars response` : 'Done'; } },
  // ── Task/Agent tools ──
  Skill:         { verb: 'used',      result: t => { const c = (t.result || '').trim(); return c ? c.slice(0, 120) : 'Done'; } },
  SkillList:     { verb: 'listed',    result: t => { const n = (t.result || '').split('\n').filter(Boolean).length; return n ? `${n} skills` : 'Done'; } },
  SkillInspect:  { verb: 'inspected', result: t => { const c = (t.result || '').trim(); return c ? `${c.split('\n').length} lines` : 'Done'; } },
  TaskAssign:    { verb: 'assigned',  result: () => 'Task dispatched' },
  TaskList:      { verb: 'listed',    result: () => 'Tasks listed' },
  TaskStop:      { verb: 'stopped',   result: () => 'Task stopped' },
  TaskOutput:    { verb: 'read',      result: t => { const c = (t.result || '').trim(); return c ? `${c.split('\n').length} lines` : 'Done'; } },
  SubAgentSpawn: { verb: 'delegated', result: () => 'Sub-agent running' },
  SubAgentDelete:{ verb: 'removed',   result: () => 'Agent removed' },
  AgentMessage:  { verb: 'messaged',  result: t => { const c = (t.result || '').trim(); return c ? c.slice(0, 80) : 'Sent'; } },
  HireEmployee:  { verb: 'hired',     result: () => 'Employee created' },
  ListEmployees: { verb: 'listed',    result: () => 'Employees listed' },
  UpdateOrg:     { verb: 'updated',   result: () => 'Org chart updated' },
  // ── Memory tools ──
  memory_save:   { verb: 'saved',    result: () => 'Memory saved' },
  memory_search: { verb: 'searched', result: t => { const n = (t.result || '').split('\n').filter(Boolean).length; return n ? `${n} entries` : 'None found'; } },
  memory_delete: { verb: 'deleted',  result: () => 'Memory deleted' },
  // ── Misc tools ──
  NotebookEdit:  { verb: 'edited',   result: () => 'Cell edited' },
  RestartServer: { verb: 'restarted',result: () => 'Server restarted' },
  Sleep:         { verb: 'waited',   result: t => { const d = t.toolInput?.seconds || t.toolInput?.duration; return d ? `${d}s` : 'Done'; } },
  TodoWrite:     { verb: 'updated',  result: () => 'Todo updated' },
};
