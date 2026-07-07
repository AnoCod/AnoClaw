// Batch-patch remaining API handlers with WS requirement checks
const fs = require('fs');

function patchFile(file, changes) {
  let c = fs.readFileSync(file, 'utf8');
  for (const [from, to] of changes) {
    if (c.includes(from)) {
      c = c.replace(from, to);
    } else {
      console.error('NOT FOUND in', file, ':', from.slice(0, 60));
    }
  }
  fs.writeFileSync(file, c);
}

// ── 1. MemoryRoutes.ts ──
patchFile('src/server/gateway/routes/MemoryRoutes.ts', [
  [
    'import { LogManager } from',
    'import { requireWsAny } from "../WsRequired.js";\nimport { LogManager } from'
  ],
  [
    'private async handleCreateMemory(\n    req: http.IncomingMessage,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    try {',
    'private async handleCreateMemory(\n    req: http.IncomingMessage,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;\n    try {'
  ],
  [
    'private async handleUpdateMemory(\n    name: string,\n    req: http.IncomingMessage,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    try {',
    'private async handleUpdateMemory(\n    name: string,\n    req: http.IncomingMessage,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;\n    try {'
  ],
  [
    'private async handleDeleteMemory(\n    name: string,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    try {',
    'private async handleDeleteMemory(\n    name: string,\n    res: http.ServerResponse,\n  ): Promise<void> {\n    if (!requireWsAny(res, this._apiServer.sendJson.bind(this._apiServer))) return;\n    try {'
  ],
]);
console.log('MemoryRoutes.ts patched');

// ── 2. SettingsRoutes.ts ──
patchFile('src/server/gateway/routes/SettingsRoutes.ts', [
  [
    'import { LogManager } from',
    'import { requireWsAny } from "../WsRequired.js";\nimport { LogManager } from'
  ],
  [
    // Put one
    '      try {\n      const body = await readBody(req);\n      const sm = SettingsManager.getInstance();\n      const current = sm.get<Record<string, unknown>>',
    '      if (!requireWsAny(res, sendJson)) return true;\n      try {\n      const body = await readBody(req);\n      const sm = SettingsManager.getInstance();\n      const current = sm.get<Record<string, unknown>>'
  ],
]);
console.log('SettingsRoutes.ts patched');

// ── 3. WorkspaceHandlers.ts ──
patchFile('src/server/gateway/handlers/WorkspaceHandlers.ts', [
  [
    'import { TokenCounter } from',
    'import { requireWsAny } from "../WsRequired.js";\nimport { TokenCounter } from'
  ],
]);
// Now add WS checks to each handler fn
let wh = fs.readFileSync('src/server/gateway/handlers/WorkspaceHandlers.ts', 'utf8');

const wsPatches = [
  ['export async function handleCreateWorkspaceDir(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
   'export async function handleCreateWorkspaceDir(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWsAny(res, sendJson)) return;\n  try {'],
  ['export async function handleCreateWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
   'export async function handleCreateWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWsAny(res, sendJson)) return;\n  try {'],
  ['export async function handleDeleteWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  _host: string,\n  _port: number,\n): Promise<void> {\n  try {',
   'export async function handleDeleteWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  _host: string,\n  _port: number,\n): Promise<void> {\n  if (!requireWsAny(res, sendJson)) return;\n  try {'],
  ['export async function handleRenameWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
   'export async function handleRenameWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWsAny(res, sendJson)) return;\n  try {'],
  ['export async function handleMoveWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
   'export async function handleMoveWorkspaceFile(\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWsAny(res, sendJson)) return;\n  try {'],
];

for (const [from, to] of wsPatches) {
  if (wh.includes(from)) {
    wh = wh.replace(from, to);
    console.log('Patched:', from.slice(0, 50));
  } else {
    console.error('NOT FOUND:', from.slice(0, 80));
  }
}
fs.writeFileSync('src/server/gateway/handlers/WorkspaceHandlers.ts', wh);
console.log('WorkspaceHandlers.ts all patched');

// ── 4. SessionHandlers — remaining: auto-title, bind-workspace, permanent delete, gc, metadata, interrupt ──
patchFile('src/server/gateway/handlers/SessionHandlers.ts', [
  // handleAutoTitle
  [
    'export async function handleAutoTitle(\n  sessionId: string,\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
    'export async function handleAutoTitle(\n  sessionId: string,\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWs(sessionId, res, sendJson)) return;\n  try {'
  ],
  // handleBindWorkspace
  [
    'export async function handleBindWorkspace(\n  sessionId: string,\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  try {',
    'export async function handleBindWorkspace(\n  sessionId: string,\n  req: http.IncomingMessage,\n  res: http.ServerResponse,\n  sendJson: SendJson,\n  readBody: ReadBody,\n): Promise<void> {\n  if (!requireWs(sessionId, res, sendJson)) return;\n  try {'
  ],
]);

console.log('SessionHandlers.ts extended');
console.log('Done');
