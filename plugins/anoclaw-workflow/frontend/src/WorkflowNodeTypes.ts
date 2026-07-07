// WorkflowNodeTypes.ts - Node type definitions, constants, ID counters
// 14 node types: agent_task, loop, end, wait, http_request, code_transform, condition, set_variable, delay, webhook, database_query, file_read, sub_workflow, approval

export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'error'
export type NodeStatus = 'idle' | 'queued' | 'running' | 'success' | 'error'

export interface WorkflowMeta {
  id: string; name: string; status: WorkflowStatus; createdAt: string; lastRunAt: string | null;
}
export interface WorkflowNode {
  id: string; type: string; x: number; y: number; title: string; description: string;
  status: NodeStatus; params: Record<string, string>; groupId: string | null;
  data?: Record<string, string>;
  inputLabels: string[]; outputLabels: string[];
}
export interface WorkflowConnection {
  id: string; fromNodeId: string; fromPortIndex: number; toNodeId: string; toPortIndex: number;
}
export interface WorkflowGroup {
  id: string; title: string; nodeIds: string[]; collapsed: boolean;
}
export interface WorkflowCanvasData {
  nodes: WorkflowNode[]; connections: WorkflowConnection[]; groups: WorkflowGroup[];
  sessionMode?: string;
}

export interface NodeTypeDef {
  label: string; color: string; group: string; inputs: number; outputs: number;
  icon: string; defaultTitle: string; inputLabels: string[]; outputLabels: string[];
  params: Array<{ label: string; type: string; key: string; placeholder?: string; options?: Array<{ value: string; label: string }> }>;
}

export const NODE_DEFS: Record<string, NodeTypeDef> = {
  agent_task: {
    label: 'Agent Task', color: '#57c1ff', group: 'AI Orchestration',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>`,
    defaultTitle: 'Agent Task', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [
      { label: 'Task Description', type: 'textarea', key: 'prompt', placeholder: 'Describe the task... Use {{variables}} for dynamic values' },
      { label: 'Assign Agent', type: 'select', key: 'agentId', options: [{ value: '', label: 'Auto Assign' }, { value: 'mainagent', label: 'Main Agent' }, { value: 'manager', label: 'Manager' }, { value: 'member', label: 'Member' }] },
    ],
  },
  loop: {
    label: 'Loop', color: '#3b82f6', group: 'Flow Control',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>`,
    defaultTitle: 'Loop', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [{ label: 'Max Iterations', type: 'number', key: 'maxIterations', placeholder: '0 = infinite' }],
  },
  end: {
    label: 'End', color: '#10b981', group: 'Flow Control',
    inputs: 1, outputs: 0, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>`,
    defaultTitle: 'End', inputLabels: ['Output'], outputLabels: [],
    params: [],
  },
  wait: {
    label: 'Wait', color: '#94a3b8', group: 'Flow Control',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    defaultTitle: 'Wait', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [{ label: 'Seconds', type: 'number', key: 'seconds', placeholder: '5' }],
  },
  http_request: {
    label: 'HTTP Request', color: '#f59e0b', group: 'Integrations',
    inputs: 1, outputs: 2, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
    defaultTitle: 'HTTP Request', inputLabels: ['Trigger'], outputLabels: ['Success', 'Error'],
    params: [
      { label: 'Method', type: 'select', key: 'method', options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }, { value: 'DELETE', label: 'DELETE' }, { value: 'PATCH', label: 'PATCH' }] },
      { label: 'URL', type: 'text', key: 'url', placeholder: 'https://api.example.com/endpoint' },
      { label: 'Headers (JSON)', type: 'textarea', key: 'headers', placeholder: '{"Content-Type": "application/json"}' },
      { label: 'Body (JSON)', type: 'textarea', key: 'body', placeholder: '{"key": "value"}' },
    ],
  },
  code_transform: {
    label: 'Code Transform', color: '#06b6d4', group: 'Transforms',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    defaultTitle: 'Code Transform', inputLabels: ['Input'], outputLabels: ['Output'],
    params: [
      { label: 'JavaScript Code', type: 'textarea', key: 'code', placeholder: '// input variable holds the input value\nreturn input;' },
      { label: 'Output Variable', type: 'text', key: 'outputVar', placeholder: 'result' },
    ],
  },
  condition: {
    label: 'Condition', color: '#ffc533', group: 'Flow Control',
    inputs: 1, outputs: 2, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
    defaultTitle: 'Condition', inputLabels: ['Input'], outputLabels: ['True', 'False'],
    params: [
      { label: 'Expression', type: 'text', key: 'expression', placeholder: '{{result}} === "success"' },
    ],
  },
  set_variable: {
    label: 'Set Variable', color: '#57c1ff', group: 'Variables',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
    defaultTitle: 'Set Variable', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [
      { label: 'Variable Name', type: 'text', key: 'varName', placeholder: 'myVariable' },
      { label: 'Value (supports {{expressions}})', type: 'text', key: 'varValue', placeholder: '{{previousNode.result}}' },
    ],
  },
  delay: {
    label: 'Delay', color: '#64748b', group: 'Flow Control',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 8 14"/></svg>`,
    defaultTitle: 'Delay', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [
      { label: 'Duration (ms)', type: 'number', key: 'durationMs', placeholder: '1000' },
    ],
  },
  webhook: {
    label: 'Webhook', color: '#22c55e', group: 'Integrations',
    inputs: 0, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
    defaultTitle: 'Webhook', inputLabels: [], outputLabels: ['Received'],
    params: [
      { label: 'Path', type: 'text', key: 'path', placeholder: '/my-webhook' },
      { label: 'Method', type: 'select', key: 'method', options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }, { value: 'PUT', label: 'PUT' }] },
    ],
  },
  database_query: {
    label: 'Database Query', color: '#57c1ff', group: 'Data',
    inputs: 1, outputs: 2, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    defaultTitle: 'Database Query', inputLabels: ['Trigger'], outputLabels: ['Results', 'Error'],
    params: [
      { label: 'Connection', type: 'select', key: 'connection', options: [{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }, { value: 'mongo', label: 'MongoDB' }, { value: 'sqlite', label: 'SQLite' }] },
      { label: 'Query', type: 'textarea', key: 'query', placeholder: 'SELECT * FROM users WHERE active = true' },
      { label: 'Output Variable', type: 'text', key: 'outputVar', placeholder: 'queryResult' },
    ],
  },
  file_read: {
    label: 'File Read/Write', color: '#fb923c', group: 'Data',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    defaultTitle: 'File Read/Write', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [
      { label: 'Operation', type: 'select', key: 'operation', options: [{ value: 'read', label: 'Read File' }, { value: 'write', label: 'Write File' }, { value: 'append', label: 'Append to File' }, { value: 'exists', label: 'Check Exists' }] },
      { label: 'File Path', type: 'text', key: 'filePath', placeholder: '/path/to/file.txt' },
      { label: 'Content (for write/append)', type: 'textarea', key: 'content', placeholder: '{{variable}} or raw content' },
      { label: 'Output Variable', type: 'text', key: 'outputVar', placeholder: 'fileContent' },
    ],
  },
  sub_workflow: {
    label: 'Sub-Workflow', color: '#14b8a6', group: 'Orchestration',
    inputs: 1, outputs: 1, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M6 8h4"/><path d="M6 11h8"/></svg>`,
    defaultTitle: 'Sub-Workflow', inputLabels: ['Trigger'], outputLabels: ['Done'],
    params: [
      { label: 'Workflow ID', type: 'text', key: 'targetWorkflowId', placeholder: 'wf_xxxxx' },
      { label: 'Pass Variables', type: 'textarea', key: 'passVars', placeholder: 'key1,key2 (comma-separated variable names to pass)' },
      { label: 'Output Variable', type: 'text', key: 'outputVar', placeholder: 'subResult' },
    ],
  },
  approval: {
    label: 'Approval', color: '#f43f5e', group: 'Human-in-the-Loop',
    inputs: 1, outputs: 2, icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>`,
    defaultTitle: 'Approval', inputLabels: ['Trigger'], outputLabels: ['Approved', 'Rejected'],
    params: [
      { label: 'Prompt', type: 'textarea', key: 'prompt', placeholder: 'Please approve this action...' },
      { label: 'Timeout (seconds)', type: 'number', key: 'timeout', placeholder: '300' },
    ],
  },
};

export const PALETTE_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: 'AI Orchestration', types: ['agent_task'] },
  { label: 'Flow Control', types: ['loop', 'end', 'wait', 'condition', 'delay'] },
  { label: 'Data', types: ['database_query', 'file_read'] },
  { label: 'Integrations', types: ['http_request', 'webhook'] },
  { label: 'Transforms', types: ['code_transform'] },
  { label: 'Variables', types: ['set_variable'] },
  { label: 'Orchestration', types: ['sub_workflow'] },
  { label: 'Human-in-the-Loop', types: ['approval'] },
];

export const NODE_WIDTH = 220;
export const STORAGE_KEY = 'anoclaw-workflow-v2';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

/** Snap-to-grid size in pixels */
export const GRID_SIZE = 20;

let _nodeIdSeq = 0, _connIdSeq = 0, _groupIdSeq = 0, _wfIdSeq = 0;

export function nextNodeId(): string { _nodeIdSeq++; return 'n' + _nodeIdSeq; }
export function nextConnId(): string { _connIdSeq++; return 'c' + _connIdSeq; }
export function nextGroupId(): string { _groupIdSeq++; return 'g' + _groupIdSeq; }

export function resetIdSeqs(nodes: WorkflowNode[], conns: WorkflowConnection[], groups: WorkflowGroup[], wfs: WorkflowMeta[]): void {
  _nodeIdSeq = 0; _connIdSeq = 0; _groupIdSeq = 0; _wfIdSeq = 0;
  for (const n of nodes) { const m = n.id.match(/^n(\d+)$/); if (m) _nodeIdSeq = Math.max(_nodeIdSeq, parseInt(m[1], 10)); }
  for (const c of conns) { const m = c.id.match(/^c(\d+)$/); if (m) _connIdSeq = Math.max(_connIdSeq, parseInt(m[1], 10)); }
  for (const g of groups) { const m = g.id.match(/^g(\d+)$/); if (m) _groupIdSeq = Math.max(_groupIdSeq, parseInt(m[1], 10)); }
  for (const w of wfs) { const m = w.id.match(/^wf(\d+)$/); if (m) _wfIdSeq = Math.max(_wfIdSeq, parseInt(m[1], 10)); }
}
