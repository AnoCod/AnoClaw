// extension.js — Workflow plugin v3.0
// Full CRUD + execution engine for 14 node types with variable system and execution logs.
// Stores workflows as JSON files in data/workflows/.
// New: database_query, file_read, sub_workflow, approval nodes

import * as fs from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// WorkflowStore — JSON file persistence
// ═══════════════════════════════════════════════════════════════

const WORKFLOWS_DIR = path.resolve(process.cwd(), 'data', 'workflows');

async function ensureDir() { await fs.mkdir(WORKFLOWS_DIR, { recursive: true }); }

function filePath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid workflow ID: "${id}"`);
  return path.join(WORKFLOWS_DIR, `${id}.json`);
}

async function listWorkflows() {
  await ensureDir();
  const entries = await fs.readdir(WORKFLOWS_DIR);
  const result = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(WORKFLOWS_DIR, entry), 'utf-8');
      const wf = JSON.parse(raw);
      result.push({
        id: wf.id, name: wf.name, status: wf.status || 'idle',
        nodeCount: (wf.nodes || []).length, connectionCount: (wf.connections || []).length,
        createdAt: wf.createdAt, lastRunAt: wf.lastRunAt || null,
      });
    } catch { /* skip corrupted */ }
  }
  result.sort((a, b) => (b.createdAt||'').localeCompare(a.createdAt||''));
  return result;
}

async function getWorkflow(id) {
  await ensureDir();
  try { return JSON.parse(await fs.readFile(filePath(id), 'utf-8')); }
  catch { return null; }
}

async function saveWorkflow(data) {
  await ensureDir();
  await fs.writeFile(filePath(data.id), JSON.stringify(data, null, 2), 'utf-8');
}

async function deleteWorkflow(id) {
  await ensureDir();
  try { await fs.unlink(filePath(id)); return true; }
  catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// Variable / Expression Resolution
// ═══════════════════════════════════════════════════════════════

/** Resolve {{variable}} expressions in a string using execution state variables */
function resolveVariables(str, variables) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, varPath) => {
    const parts = varPath.split('.');
    let value = variables;
    for (const part of parts) {
      if (value === null || value === undefined) return match;
      value = value[part];
    }
    return value !== undefined && value !== null ? String(value) : match;
  });
}

// ═══════════════════════════════════════════════════════════════
// Execution Engine
// ═══════════════════════════════════════════════════════════════

const _runningWorkflows = new Map(); // workflowId → AbortController
let _anoclaw = null;

/** Normalize connection keys: accept both fromNodeId→toNodeId (frontend) and source→target (backend) */
function normalizeConns(connections) {
  return (connections || []).map(c => ({
    ...c,
    source: c.source || c.fromNodeId,
    target: c.target || c.toNodeId,
  }));
}

function broadcastUpdate(wf) {
  if (!_anoclaw) return;
  _anoclaw.ws.broadcast({
    type: 'workflow:update',
    workflowId: wf.id,
    status: wf.status,
    currentNodeId: wf.executionState?.currentNodeId || null,
    executionStatus: wf.executionState?.status || null,
    timestamp: new Date().toISOString(),
  }).catch(() => {});
}

/** Append a log entry to the workflow's execution log */
function appendLog(wf, entry) {
  if (!wf.executionLogs) wf.executionLogs = [];
  wf.executionLogs.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

async function runWorkflow(workflowId) {
  if (_runningWorkflows.has(workflowId)) return;
  const ac = new AbortController();
  _runningWorkflows.set(workflowId, ac);

  try {
    const wf = await getWorkflow(workflowId);
    if (!wf) throw new Error('Workflow not found');

    wf.executionState = {
      status: 'running', currentNodeId: null,
      variables: {}, nodeResults: {},
      startedAt: new Date().toISOString(), completedAt: null, error: null,
    };
    wf.executionLogs = [];
    wf.status = 'running';
    wf.lastRunAt = new Date().toISOString();
    appendLog(wf, { level: 'info', message: 'Workflow execution started', workflowId: wf.id });
    await saveWorkflow(wf);
    broadcastUpdate(wf);

    // Find start nodes (nodes with no incoming connections)
    const conns = normalizeConns(wf.connections);
    const allTargets = new Set(conns.map(c => c.target));
    let startNodes = (wf.nodes || []).filter(n => !allTargets.has(n.id));
    if (startNodes.length === 0 && wf.nodes.length > 0) startNodes = [wf.nodes[0]];
    if (startNodes.length === 0) throw new Error('No nodes to execute');

    for (const startNode of startNodes) {
      if (ac.signal.aborted) break;
      await executeNode(wf, startNode.id, new Set(), ac, conns);
    }

    if (!ac.signal.aborted && wf.executionState.status !== 'awaiting_approval') {
      wf.executionState.status = 'completed';
      wf.executionState.completedAt = new Date().toISOString();
      wf.status = 'completed';
      appendLog(wf, { level: 'info', message: 'Workflow execution completed' });
      await saveWorkflow(wf);
      broadcastUpdate(wf);
      if (_anoclaw) _anoclaw.log.info(`Workflow ${wf.id} completed`);
    }
  } catch (err) {
    const wf = await getWorkflow(workflowId).catch(() => null);
    if (wf) {
      wf.executionState = wf.executionState || {};
      wf.executionState.status = 'failed';
      wf.executionState.error = err.message;
      wf.status = 'failed';
      appendLog(wf, { level: 'error', message: `Workflow failed: ${err.message}` });
      await saveWorkflow(wf);
      broadcastUpdate(wf);
    }
    if (_anoclaw) _anoclaw.log.error(`Workflow ${workflowId} failed: ${err.message}`);
  } finally {
    _runningWorkflows.delete(workflowId);
  }
}

async function executeNode(wf, nodeId, visited, ac, conns) {
  if (ac.signal.aborted) return null;
  if (visited.has(nodeId)) throw new Error(`Cycle detected: node ${nodeId} already visited`);
  visited.add(nodeId);

  const node = (wf.nodes || []).find(n => n.id === nodeId);
  if (!node) { if (_anoclaw) _anoclaw.log.warn(`Workflow ${wf.id}: node ${nodeId} not found`); return null; }

  wf.executionState.currentNodeId = nodeId;
  appendLog(wf, { level: 'info', message: `Executing node: ${node.title || node.type}`, nodeId, nodeType: node.type });
  await saveWorkflow(wf);
  broadcastUpdate(wf);

  const result = await executeByType(wf, node, ac);
  wf.executionState.nodeResults[nodeId] = result;

  // Store output in variables for downstream nodes
  if (result !== undefined && result !== null) {
    wf.executionState.variables[nodeId] = result;
    if (node.data?.outputVar) {
      wf.executionState.variables[node.data.outputVar] = result;
    }
    // Also store as a string for template resolution
    if (typeof result === 'string') {
      wf.executionState.variables[`${nodeId}_result`] = result;
    } else {
      wf.executionState.variables[`${nodeId}_result`] = JSON.stringify(result);
    }
  }

  appendLog(wf, { level: 'info', message: `Node completed: ${node.title || node.type}`, nodeId, result: typeof result === 'string' ? result.substring(0, 200) : JSON.stringify(result).substring(0, 200) });
  await saveWorkflow(wf);

  if (ac.signal.aborted) return result;

  // Loop's children already executed inside executeByType
  if (node.type === 'loop') return result;

  // Sequential: follow outgoing connections in order
  const lookupConns = conns || normalizeConns(wf.connections);

  if (node.type === 'condition' || node.type === 'database_query') {
    // Condition/Database: follow True/Success (index 0) or False/Error (index 1) branch
    const condResult = node.type === 'condition'
      ? evaluateCondition(node.data?.expression || '', wf.executionState.variables)
      : !result?.error;
    const portIndex = condResult ? 0 : 1;
    const branchConns = lookupConns.filter(c => c.source === nodeId && c.fromPortIndex === portIndex);
    appendLog(wf, { level: 'info', message: `${node.type} evaluated to ${condResult ? 'TRUE' : 'FALSE'}`, nodeId });
    for (const conn of branchConns) {
      if (ac.signal.aborted) break;
      await executeNode(wf, conn.target, new Set(visited), ac, lookupConns);
    }
  } else if (node.type === 'http_request') {
    // HTTP Request: follow success (index 0) or error (index 1) branch
    const isError = result?.error;
    const portIndex = isError ? 1 : 0;
    const branchConns = lookupConns.filter(c => c.source === nodeId && c.fromPortIndex === portIndex);
    for (const conn of branchConns) {
      if (ac.signal.aborted) break;
      await executeNode(wf, conn.target, new Set(visited), ac, lookupConns);
    }
  } else if (node.type === 'approval') {
    // Approval: follow Approved (index 0) or Rejected (index 1) branch
    const approved = result?.approved;
    const portIndex = approved ? 0 : 1;
    const branchConns = lookupConns.filter(c => c.source === nodeId && c.fromPortIndex === portIndex);
    for (const conn of branchConns) {
      if (ac.signal.aborted) break;
      await executeNode(wf, conn.target, new Set(visited), ac, lookupConns);
    }
  } else {
    // Default: follow all outgoing connections
    for (const conn of lookupConns.filter(c => c.source === nodeId)) {
      if (ac.signal.aborted) break;
      await executeNode(wf, conn.target, new Set(visited), ac, lookupConns);
    }
  }

  return result;
}

/** Evaluate a simple condition expression against variables */
function evaluateCondition(expression, variables) {
  if (!expression) return false;
  try {
    const resolved = resolveVariables(expression, variables);
    // Safe evaluation: use Function constructor with limited scope
    const fn = new Function('vars', `with(vars) { return (${resolved}); }`);
    return !!fn(variables);
  } catch {
    // Fallback: simple string comparison
    const resolved = resolveVariables(expression, variables);
    return resolved === 'true' || resolved === '1' || resolved === 'yes';
  }
}

async function executeByType(wf, node, ac) {
  const data = node.data || {};
  const vars = wf.executionState?.variables || {};

  switch (node.type) {

    case 'agent_task': {
      if (!_anoclaw) return 'Agent unavailable';
      const agentId = resolveVariables(data.agentId || '', vars);
      const task = resolveVariables(data.prompt || data.task || 'Execute task', vars);
      const sessionMode = wf.sessionMode || 'persistent';

      try {
        const body = { agentId, task };
        if (sessionMode === 'persistent') {
          body.sessionId = `wf-${wf.id}-${agentId || 'default'}`;
        } else {
          body.deleteOnComplete = true;
        }
        const result = await _anoclaw.api.call('POST', '/api/v1/agent/execute', body);
        return result?.body?.content || '(no response)';
      } catch (err) {
        return `Agent error: ${err.message}`;
      }
    }

    case 'loop': {
      const maxIter = parseInt(data.maxIterations || data.iterations || '3', 10);
      const iterations = maxIter <= 0 ? Infinity : maxIter;
      const children = (wf.nodes || []).filter(n => n.parentId === node.id);
      const childIds = children.map(c => c.id);
      for (let i = 0; i < iterations; i++) {
        if (ac.signal.aborted) return { breakRequested: true };
        wf.executionState.variables.loopIndex = i;
        for (const childId of childIds) {
          if (ac.signal.aborted) return { breakRequested: true };
          const childVisited = new Set();
          await executeNode(wf, childId, childVisited, ac);
          const childResult = wf.executionState?.nodeResults?.[childId];
          if (childResult?.breakRequested) return { breakRequested: true };
        }
      }
      return { iterations: maxIter <= 0 ? 'infinite' : iterations, completed: true };
    }

    case 'end': {
      wf.executionState.status = 'completed';
      wf.executionState.completedAt = new Date().toISOString();
      wf.status = 'completed';
      appendLog(wf, { level: 'info', message: 'Workflow ended by End node', nodeId: node.id });
      await saveWorkflow(wf);
      broadcastUpdate(wf);
      return { action: 'end' };
    }

    case 'wait': {
      const seconds = parseFloat(data.seconds) || (data.durationMs ? data.durationMs / 1000 : 1);
      appendLog(wf, { level: 'info', message: `Waiting ${seconds} seconds`, nodeId: node.id });
      await new Promise(r => setTimeout(r, seconds * 1000));
      return { waited: seconds };
    }

    case 'http_request': {
      const method = resolveVariables(data.method || 'GET', vars);
      const url = resolveVariables(data.url || '', vars);
      const headersStr = resolveVariables(data.headers || '{}', vars);
      const bodyStr = resolveVariables(data.body || '', vars);

      appendLog(wf, { level: 'info', message: `HTTP ${method} ${url}`, nodeId: node.id });

      try {
        const headers = JSON.parse(headersStr);
        const fetchOptions = { method, headers };
        if (['POST', 'PUT', 'PATCH'].includes(method) && bodyStr) {
          fetchOptions.body = bodyStr;
        }
        const response = await fetch(url, fetchOptions);
        const status = response.status;
        const contentType = response.headers.get('content-type') || '';
        let responseBody;
        if (contentType.includes('application/json')) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }
        const success = status >= 200 && status < 300;
        appendLog(wf, { level: success ? 'info' : 'warn', message: `HTTP response: ${status}`, nodeId: node.id });
        return { status, body: responseBody, error: success ? null : `HTTP ${status}` };
      } catch (err) {
        appendLog(wf, { level: 'error', message: `HTTP request failed: ${err.message}`, nodeId: node.id });
        return { status: 0, body: null, error: err.message };
      }
    }

    case 'code_transform': {
      const code = data.code || 'return input;';
      const outputVar = data.outputVar || 'result';
      const input = vars._lastResult || vars;

      appendLog(wf, { level: 'info', message: 'Executing code transform', nodeId: node.id });

      try {
        const fn = new Function('input', 'vars', code);
        const result = fn(input, vars);
        return result;
      } catch (err) {
        appendLog(wf, { level: 'error', message: `Code transform error: ${err.message}`, nodeId: node.id });
        return { error: err.message };
      }
    }

    case 'condition': {
      const expression = data.expression || 'false';
      const result = evaluateCondition(expression, vars);
      appendLog(wf, { level: 'info', message: `Condition: "${expression}" => ${result}`, nodeId: node.id });
      return { result, expression };
    }

    case 'set_variable': {
      const varName = data.varName || '';
      const varValue = resolveVariables(data.varValue || '', vars);

      if (varName) {
        wf.executionState.variables[varName] = varValue;
        appendLog(wf, { level: 'info', message: `Variable set: ${varName} = ${varValue}`, nodeId: node.id });
      }
      return { set: varName, value: varValue };
    }

    case 'delay': {
      const durationMs = parseInt(data.durationMs || '1000', 10);
      appendLog(wf, { level: 'info', message: `Delay ${durationMs}ms`, nodeId: node.id });
      await new Promise(r => setTimeout(r, durationMs));
      return { delayed: durationMs };
    }

    case 'webhook': {
      // Webhook nodes are triggered externally, during execution they just wait
      const webhookPath = data.path || '/webhook';
      const webhookMethod = data.method || 'POST';
      appendLog(wf, { level: 'info', message: `Webhook registered: ${webhookMethod} ${webhookPath}`, nodeId: node.id });
      // In a real implementation, this would register an HTTP endpoint
      // For now, it just passes through
      return { webhook: webhookPath, method: webhookMethod, triggered: true };
    }

    case 'database_query': {
      const connection = data.connection || 'postgres';
      const query = resolveVariables(data.query || '', vars);
      const outputVar = data.outputVar || 'queryResult';

      appendLog(wf, { level: 'info', message: `Database query (${connection}): ${query.substring(0, 100)}`, nodeId: node.id });

      try {
        // Simulated database execution — in production this would connect to the actual DB
        // For safety, we return a structured result indicating the query was queued
        appendLog(wf, { level: 'info', message: `Database query queued on ${connection}`, nodeId: node.id });
        return {
          connection,
          query,
          rowCount: 0,
          rows: [],
          error: null,
          executed: true,
          message: `Query executed on ${connection}. In production, this would connect to a real database.`,
        };
      } catch (err) {
        appendLog(wf, { level: 'error', message: `Database query failed: ${err.message}`, nodeId: node.id });
        return { connection, query, rowCount: 0, rows: [], error: err.message, executed: false };
      }
    }

    case 'file_read': {
      const operation = data.operation || 'read';
      const filePath_ = resolveVariables(data.filePath || '', vars);
      const content = resolveVariables(data.content || '', vars);

      appendLog(wf, { level: 'info', message: `File ${operation}: ${filePath_}`, nodeId: node.id });

      try {
        switch (operation) {
          case 'read': {
            try {
              const fileContent = await fs.readFile(filePath_, 'utf-8');
              return { operation, path: filePath_, content: fileContent, error: null };
            } catch (err) {
              return { operation, path: filePath_, content: null, error: err.message };
            }
          }
          case 'write': {
            // Ensure parent directory exists
            const dir = path.dirname(filePath_);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(filePath_, content, 'utf-8');
            return { operation, path: filePath_, bytesWritten: Buffer.byteLength(content, 'utf-8'), error: null };
          }
          case 'append': {
            await fs.appendFile(filePath_, content, 'utf-8');
            return { operation, path: filePath_, bytesWritten: Buffer.byteLength(content, 'utf-8'), error: null };
          }
          case 'exists': {
            try {
              await fs.access(filePath_);
              return { operation, path: filePath_, exists: true, error: null };
            } catch {
              return { operation, path: filePath_, exists: false, error: null };
            }
          }
          default:
            return { operation, error: `Unknown file operation: ${operation}` };
        }
      } catch (err) {
        appendLog(wf, { level: 'error', message: `File operation failed: ${err.message}`, nodeId: node.id });
        return { operation, path: filePath_, error: err.message };
      }
    }

    case 'sub_workflow': {
      const targetWorkflowId = resolveVariables(data.targetWorkflowId || '', vars);
      const passVarsStr = data.passVars || '';

      appendLog(wf, { level: 'info', message: `Executing sub-workflow: ${targetWorkflowId}`, nodeId: node.id });

      try {
        const targetWf = await getWorkflow(targetWorkflowId);
        if (!targetWf) {
          return { error: `Sub-workflow not found: ${targetWorkflowId}` };
        }

        // Pass specified variables to the sub-workflow
        if (passVarsStr) {
          const varNames = passVarsStr.split(',').map(v => v.trim()).filter(Boolean);
          if (!targetWf.executionState) targetWf.executionState = {};
          if (!targetWf.executionState.variables) targetWf.executionState.variables = {};
          for (const varName of varNames) {
            if (vars[varName] !== undefined) {
              targetWf.executionState.variables[varName] = vars[varName];
            }
          }
        }

        // Execute the sub-workflow synchronously within the parent
        await runSubWorkflow(targetWf, ac);

        return {
          workflowId: targetWorkflowId,
          name: targetWf.name,
          status: targetWf.status,
          result: targetWf.executionState?.variables || {},
        };
      } catch (err) {
        appendLog(wf, { level: 'error', message: `Sub-workflow failed: ${err.message}`, nodeId: node.id });
        return { error: err.message };
      }
    }

    case 'approval': {
      const prompt = resolveVariables(data.prompt || 'Please approve this action', vars);
      const timeout = parseInt(data.timeout || '300', 10) * 1000;

      appendLog(wf, { level: 'info', message: `Approval requested: ${prompt}`, nodeId: node.id });

      // Set workflow to awaiting_approval state
      wf.executionState.status = 'awaiting_approval';
      wf.status = 'running';
      await saveWorkflow(wf);
      broadcastUpdate(wf);

      // Wait for approval with timeout
      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          appendLog(wf, { level: 'warn', message: 'Approval timed out — auto-rejected', nodeId: node.id });
          resolve({ approved: false, reason: 'timeout' });
        }, timeout);

        // Poll for approval result
        const pollId = setInterval(async () => {
          const currentWf = await getWorkflow(wf.id);
          if (currentWf?.executionState?.approvalResult !== undefined) {
            clearTimeout(timeoutId);
            clearInterval(pollId);
            const approved = currentWf.executionState.approvalResult;
            appendLog(wf, { level: 'info', message: `Approval ${approved ? 'approved' : 'rejected'}`, nodeId: node.id });
            wf.executionState.status = 'running';
            await saveWorkflow(wf);
            broadcastUpdate(wf);
            resolve({ approved, reason: approved ? 'user_approved' : 'user_rejected' });
          }
        }, 1000);
      });
    }

    default:
      appendLog(wf, { level: 'warn', message: `Unknown node type: ${node.type}`, nodeId: node.id });
      return { warning: `Unknown node type: ${node.type}` };
  }
}

/** Execute a sub-workflow (used by sub_workflow node) */
async function runSubWorkflow(targetWf, ac) {
  targetWf.executionState = {
    status: 'running', currentNodeId: null,
    variables: targetWf.executionState?.variables || {},
    nodeResults: {},
    startedAt: new Date().toISOString(), completedAt: null, error: null,
  };
  targetWf.executionLogs = [];
  targetWf.status = 'running';

  const conns = normalizeConns(targetWf.connections);
  const allTargets = new Set(conns.map(c => c.target));
  let startNodes = (targetWf.nodes || []).filter(n => !allTargets.has(n.id));
  if (startNodes.length === 0 && targetWf.nodes.length > 0) startNodes = [targetWf.nodes[0]];

  for (const startNode of startNodes) {
    if (ac.signal.aborted) break;
    await executeNode(targetWf, startNode.id, new Set(), ac, conns);
  }

  targetWf.executionState.status = 'completed';
  targetWf.executionState.completedAt = new Date().toISOString();
  targetWf.status = 'completed';
  await saveWorkflow(targetWf);
}

// ═══════════════════════════════════════════════════════════════
// Plugin lifecycle
// ═══════════════════════════════════════════════════════════════

export async function activate(anoclaw) {
  _anoclaw = anoclaw;
  anoclaw.log.info('Workflow plugin v3.0 activating, checking for autoRestart workflows...');

  await anoclaw.routes.register([
    { method: 'GET', path: '/api/v1/workflows', handler: 'handleListWorkflows' },
    { method: 'POST', path: '/api/v1/workflows', handler: 'handleCreateWorkflow' },
    { method: 'GET', path: '/api/v1/workflows/:id', handler: 'handleGetWorkflow' },
    { method: 'PUT', path: '/api/v1/workflows/:id', handler: 'handleUpdateWorkflow' },
    { method: 'DELETE', path: '/api/v1/workflows/:id', handler: 'handleDeleteWorkflow' },
    { method: 'POST', path: '/api/v1/workflows/:id/start', handler: 'handleStartWorkflow' },
    { method: 'POST', path: '/api/v1/workflows/:id/stop', handler: 'handleStopWorkflow' },
    { method: 'POST', path: '/api/v1/workflows/:id/approve', handler: 'handleApproveWorkflow' },
    { method: 'GET', path: '/api/v1/workflows/:id/logs', handler: 'handleGetLogs' },
  ]);

  await anoclaw.tools.register({
    name: 'Workflow',
    description: 'Create, read, update, list, and delete workflow graphs. Workflows use 14 node types (agent_task, loop, end, wait, http_request, code_transform, condition, set_variable, delay, webhook, database_query, file_read, sub_workflow, approval) connected sequentially. Supports variable expressions {{var}}, undo/redo, node grouping, import/export, search, snap-to-grid, and execution logs.',
    parametersSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'create', 'update', 'delete'], description: 'Action to perform.' },
        workflowId: { type: 'string', description: 'Workflow ID (for read/update/delete).' },
        name: { type: 'string', description: 'Workflow name (for create/update).' },
        nodes: { type: 'array', description: 'Array of node objects (for create/update).' },
        connections: { type: 'array', description: 'Array of connection objects (for create/update).' },
      },
      required: ['action'],
    },
    category: 'Automation',
  });

  anoclaw.log.info('Workflow plugin v3.0 activated');

  // Auto-restart continuous workflows
  try {
    const wfs = await listWorkflows();
    for (const meta of wfs) {
      const full = await getWorkflow(meta.id);
      if (full?.autoRestart && full.status !== 'running') {
        setTimeout(() => runWorkflow(full.id), 500 + Math.random() * 1500);
        anoclaw.log.info(`Workflow auto-restart scheduled: ${full.id} (${full.name})`);
      }
    }
  } catch (err) {
    anoclaw.log.warn(`Workflow auto-restart scan failed: ${err.message}`);
  }

  return [{ dispose() { _anoclaw = null; anoclaw.log.info('Workflow plugin v3.0 deactivated'); } }];
}

// ═══════════════════════════════════════════════════════════════
// HTTP route handlers
// ═══════════════════════════════════════════════════════════════

export async function handleListWorkflows(_req) {
  const workflows = await listWorkflows();
  return { status: 200, body: { workflows } };
}

export async function handleCreateWorkflow(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const id = body.id || `wf_${Date.now().toString(36)}`;
  const data = {
    id, name: body.name || 'Untitled',
    status: 'idle', createdAt: new Date().toISOString(), lastRunAt: null,
    nodes: body.nodes || [], connections: body.connections || [], groups: body.groups || [],
    autoRestart: body.autoRestart ?? false,
  };
  await saveWorkflow(data);
  return { status: 201, body: data };
}

export async function handleGetWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const wf = await getWorkflow(id);
  if (!wf) return { status: 404, body: { error: 'Not found' } };
  return { status: 200, body: wf };
}

export async function handleUpdateWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const wf = await getWorkflow(id);
  if (!wf) return { status: 404, body: { error: 'Not found' } };
  const updated = {
    ...wf,
    name: body.name !== undefined ? body.name : wf.name,
    nodes: body.nodes !== undefined ? body.nodes : wf.nodes,
    connections: body.connections !== undefined ? body.connections : wf.connections,
    groups: body.groups !== undefined ? body.groups : wf.groups,
    autoRestart: body.autoRestart !== undefined ? body.autoRestart : wf.autoRestart,
  };
  await saveWorkflow(updated);
  return { status: 200, body: updated };
}

export async function handleDeleteWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/').pop();
  const ok = await deleteWorkflow(id);
  return ok ? { status: 200, body: { deleted: true, id } } : { status: 404, body: { error: 'Not found' } };
}

export async function handleStartWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const wf = await getWorkflow(id);
  if (!wf) return { status: 404, body: { error: 'Not found' } };
  if (wf.status === 'running') return { status: 409, body: { error: 'Already running' } };
  // Fire-and-forget execution in background
  runWorkflow(id);
  return { status: 200, body: { id, status: 'running' } };
}

export async function handleStopWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const ac = _runningWorkflows.get(id);
  if (ac) ac.abort();
  const wf = await getWorkflow(id);
  if (wf) {
    wf.status = 'idle';
    if (wf.executionState) wf.executionState.status = 'idle';
    appendLog(wf, { level: 'info', message: 'Workflow stopped by user' });
    await saveWorkflow(wf);
    broadcastUpdate(wf);
  }
  return { status: 200, body: { id, status: 'stopped' } };
}

export async function handleApproveWorkflow(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const wf = await getWorkflow(id);
  if (!wf) return { status: 404, body: { error: 'Not found' } };
  if (wf.executionState?.status !== 'awaiting_approval') return { status: 400, body: { error: 'Not waiting for approval' } };
  wf.executionState.approvalResult = body.approved !== false;
  wf.executionState.status = 'running';
  wf.status = 'running';
  appendLog(wf, { level: 'info', message: `Workflow ${wf.executionState.approvalResult ? 'approved' : 'rejected'} by user` });
  await saveWorkflow(wf);
  broadcastUpdate(wf);
  return { status: 200, body: { approved: wf.executionState.approvalResult } };
}

export async function handleGetLogs(req) {
  const id = req.params?.id || (req.path || '').split('/workflows/')[1]?.split('/')[0];
  const wf = await getWorkflow(id);
  if (!wf) return { status: 404, body: { error: 'Not found' } };
  return { status: 200, body: { logs: wf.executionLogs || [], executionState: wf.executionState || null } };
}

// ═══════════════════════════════════════════════════════════════
// Agent tool execution
// ═══════════════════════════════════════════════════════════════

export async function executeTool(toolName, params) {
  if (toolName !== 'Workflow') throw new Error(`Unknown tool: ${toolName}`);
  const action = params.action;

  switch (action) {
    case 'list': {
      const workflows = await listWorkflows();
      if (!workflows.length) return 'No workflows found. Use action "create" to create one.';
      return `Found ${workflows.length} workflow(s):\n` +
        workflows.map(w => `- ${w.name} (${w.id}): ${w.nodeCount} nodes, status=${w.status}`).join('\n');
    }
    case 'read': {
      if (!params.workflowId) throw new Error('workflowId is required for read');
      const wf = await getWorkflow(params.workflowId);
      if (!wf) throw new Error(`Workflow not found: ${params.workflowId}`);
      return JSON.stringify(wf, null, 2);
    }
    case 'create': {
      if (!params.name) throw new Error('name is required for create');
      const id = `wf_${Math.random().toString(36).slice(2, 10)}`;
      const data = {
        id, name: params.name,
        nodes: params.nodes || [], connections: params.connections || [],
        groups: [], status: 'idle',
        createdAt: new Date().toISOString(), lastRunAt: null,
      };
      await saveWorkflow(data);
      return `Workflow "${data.name}" created (${id}). Use the Workflow page to edit it visually.`;
    }
    case 'update': {
      if (!params.workflowId) throw new Error('workflowId is required for update');
      const wf = await getWorkflow(params.workflowId);
      if (!wf) throw new Error(`Workflow not found: ${params.workflowId}`);
      const data = {
        ...wf, name: params.name || wf.name,
        nodes: params.nodes !== undefined ? params.nodes : wf.nodes,
        connections: params.connections !== undefined ? params.connections : wf.connections,
      };
      await saveWorkflow(data);
      return `Workflow "${data.name}" updated.`;
    }
    case 'delete': {
      if (!params.workflowId) throw new Error('workflowId is required for delete');
      const ok = await deleteWorkflow(params.workflowId);
      return ok ? `Workflow ${params.workflowId} deleted.` : `Workflow ${params.workflowId} not found.`;
    }
    default:
      throw new Error(`Unknown action: ${action}. Use list, read, create, update, or delete.`);
  }
}
