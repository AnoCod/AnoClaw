// extension.js — ComfyUI plugin v2.1 (merged)
// Core: workflow inspection, generation, dependency checking, GitHub download.
// Process management: start/stop/monitor ComfyUI as a subprocess.
// Frontend: visual prompt-to-image interface.
// HTTP routes: image proxy, process management API.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { WebSocket } from 'ws';
import { spawn } from 'child_process';

// ═══════════════════════════════════════════════════════════════
// ComfyUICatalog (inlined from kernel)
// ═══════════════════════════════════════════════════════════════

const PARAM_PATTERNS = [
  { classType: 'CLIPTextEncode', field: 'text', friendlyName: 'prompt' },
  { classType: 'CLIPTextEncodeSDXL', field: 'text_g', friendlyName: 'prompt' },
  { classType: 'CLIPTextEncodeSDXL', field: 'text_l', friendlyName: 'prompt_l' },
  { classType: 'CLIPTextEncodeSDXLRefiner', field: 'text', friendlyName: 'refiner_prompt' },
  { classType: 'CLIPTextEncodeFlux', field: 'clip_l', friendlyName: 'prompt_l' },
  { classType: 'CLIPTextEncodeFlux', field: 't5xxl', friendlyName: 'prompt' },
  { classType: 'CLIPTextEncodeFlux', field: 'guidance', friendlyName: 'guidance' },
  { classType: 'smZ CLIPTextEncode', field: 'text', friendlyName: 'prompt' },
  { classType: 'BNK_CLIPTextEncodeAdvanced', field: 'text', friendlyName: 'prompt' },
  { classType: 'KSampler', field: 'seed', friendlyName: 'seed' },
  { classType: 'KSampler', field: 'steps', friendlyName: 'steps' },
  { classType: 'KSampler', field: 'cfg', friendlyName: 'cfg' },
  { classType: 'KSampler', field: 'denoise', friendlyName: 'denoise' },
  { classType: 'KSamplerAdvanced', field: 'noise_seed', friendlyName: 'seed' },
  { classType: 'KSamplerAdvanced', field: 'steps', friendlyName: 'steps' },
  { classType: 'KSamplerAdvanced', field: 'cfg', friendlyName: 'cfg' },
  { classType: 'KSamplerAdvanced', field: 'start_at_step', friendlyName: 'start_at_step' },
  { classType: 'KSamplerAdvanced', field: 'end_at_step', friendlyName: 'end_at_step' },
  { classType: 'SamplerCustom', field: 'noise_seed', friendlyName: 'seed' },
  { classType: 'SamplerCustom', field: 'cfg', friendlyName: 'cfg' },
  { classType: 'BasicScheduler', field: 'steps', friendlyName: 'steps' },
  { classType: 'BasicScheduler', field: 'denoise', friendlyName: 'denoise' },
  { classType: 'RandomNoise', field: 'noise_seed', friendlyName: 'seed' },
  { classType: 'EmptyLatentImage', field: 'width', friendlyName: 'width' },
  { classType: 'EmptyLatentImage', field: 'height', friendlyName: 'height' },
  { classType: 'EmptySD3LatentImage', field: 'width', friendlyName: 'width' },
  { classType: 'EmptySD3LatentImage', field: 'height', friendlyName: 'height' },
  { classType: 'EmptyFluxLatentImage', field: 'width', friendlyName: 'width' },
  { classType: 'EmptyFluxLatentImage', field: 'height', friendlyName: 'height' },
  { classType: 'FluxGuidance', field: 'guidance', friendlyName: 'guidance' },
  { classType: 'ModelSamplingFlux', field: 'max_shift', friendlyName: 'max_shift' },
  { classType: 'ModelSamplingFlux', field: 'base_shift', friendlyName: 'base_shift' },
  { classType: 'ModelSamplingFlux', field: 'width', friendlyName: 'width' },
  { classType: 'ModelSamplingFlux', field: 'height', friendlyName: 'height' },
];

const MODEL_LOADERS = [
  { classType: 'CheckpointLoaderSimple', field: 'ckpt_name', folder: 'checkpoints' },
  { classType: 'UNETLoader', field: 'unet_name', folder: 'unet' },
  { classType: 'VAELoader', field: 'vae_name', folder: 'vae' },
  { classType: 'DualCLIPLoader', field: 'clip_name1', folder: 'clip' },
  { classType: 'DualCLIPLoader', field: 'clip_name2', folder: 'clip' },
  { classType: 'CLIPLoader', field: 'clip_name', folder: 'clip' },
  { classType: 'LoraLoader', field: 'lora_name', folder: 'loras' },
  { classType: 'LoraLoaderModelOnly', field: 'lora_name', folder: 'loras' },
  { classType: 'ControlNetLoader', field: 'control_net_name', folder: 'controlnet' },
  { classType: 'UpscaleModelLoader', field: 'model_name', folder: 'upscale_models' },
  { classType: 'LoadImage', field: 'image', folder: 'input' },
];

const OUTPUT_NODES = new Set(['SaveImage', 'PreviewImage', 'VAEDecode', 'VHS_VideoCombine', 'SaveAnimatedWEBP', 'SaveAnimatedPNG']);
const SAMPLER_NODE_FAMILY = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'BNK_CustomSamplerAdvanced', 'SamplerCustomAdvanced']);
const PROMPT_FIELDS = new Set(['text', 'text_g', 'text_l', 'clip_l', 't5xxl']);
const PASSTHROUGH_NODES = new Set(['Reroute', 'Primitive', 'Note', 'Reroute (rgthree)']);

function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

// ═══════════════════════════════════════════════════════════════
// ComfyUIService (inlined from kernel)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_BASE = 'http://127.0.0.1:8188';
const DEFAULT_OUTPUT_DIR = 'F:/ComfyUI/output';

class ComfyUIService {
  constructor(baseUrl) {
    this._baseUrl = baseUrl || DEFAULT_BASE;
  }

  _request(method, urlPath, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this._baseUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const headers = {};
      if (opts.body) headers['Content-Type'] = opts.contentType || 'application/json';

      const req = transport.request(url, { method, headers, signal: opts.signal, timeout: opts.timeoutMs ?? 30000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 500, text: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async healthCheck(timeoutMs = 10000) {
    try { const r = await this._request('GET', '/system_stats', { timeoutMs }); return r.status === 200; }
    catch { return false; }
  }

  async waitForReady(timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) { if (await this.healthCheck(5000)) return true; await sleep(10000); }
    return false;
  }

  async uploadImage(filePath) {
    const fileName = path.basename(filePath);
    const buffer = await fs.readFile(filePath);
    const boundary = `----ComfyUpload${Date.now()}`;
    const CRLF = '\r\n';
    const parts = [];
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="image"; filename="${fileName}"${CRLF}`));
    parts.push(Buffer.from(`Content-Type: application/octet-stream${CRLF}${CRLF}`));
    parts.push(buffer);
    parts.push(Buffer.from(`${CRLF}--${boundary}${CRLF}`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="overwrite"${CRLF}${CRLF}true${CRLF}`));
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const body = Buffer.concat(parts);
    const resp = await this._request('POST', '/upload/image', { body, timeoutMs: 30000, contentType: `multipart/form-data; boundary=${boundary}` });
    if (resp.status !== 200) throw new Error(`Upload failed: ${resp.status}`);
    try { return JSON.parse(resp.text).name || fileName; } catch { return fileName; }
  }

  async submitWorkflow(workflow) {
    const payload = { prompt: workflow, client_id: `anoclaw-${Date.now()}` };
    const resp = await this._request('POST', '/prompt', { body: JSON.stringify(payload), timeoutMs: 30000 });
    if (resp.status !== 200) throw new Error(`Submit failed: ${resp.status} ${resp.text}`);
    const data = JSON.parse(resp.text);
    if (data.error) throw new Error(`ComfyUI error: ${data.error}`);
    if (!data.prompt_id) throw new Error('No prompt_id in ComfyUI response');
    return data.prompt_id;
  }

  async waitForResult(promptId, timeoutMs = 300000, onProgress) {
    // Connect WebSocket for real-time progress
    connectWebSocket();
    
    return new Promise((resolve, reject) => {
      const start = Date.now();
      
      // Register callback for WS progress
      if (onProgress) {
        generationCallbacks.set(promptId, { onProgress });
      }
      
      // Poll for result as fallback
      const pollInterval = setInterval(async () => {
        if (Date.now() - start >= timeoutMs) {
          clearInterval(pollInterval);
          generationCallbacks.delete(promptId);
          reject(new Error(`ComfyUI generation timed out after ${timeoutMs / 1000}s`));
          return;
        }
        
        try {
          const resp = await this._request('GET', `/history/${promptId}`, { timeoutMs: 10000 });
          if (resp.status !== 200) return;
          const data = JSON.parse(resp.text);
          const entry = data[promptId];
          if (!entry?.outputs) return;
          const images = [];
          for (const nodeOutput of Object.values(entry.outputs)) {
            if (nodeOutput.images) for (const img of nodeOutput.images) {
              images.push(img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename);
            }
          }
          clearInterval(pollInterval);
          generationCallbacks.delete(promptId);
          resolve(images);
        } catch {}
      }, 2000);
      
      // Also listen for completion via WebSocket
      const wsCallback = {
        onComplete: () => {
          // Give polling a moment to get the final result
          setTimeout(() => {
            clearInterval(pollInterval);
            generationCallbacks.delete(promptId);
            // Try one more poll for the result
            this._request('GET', `/history/${promptId}`, { timeoutMs: 10000 }).then(resp => {
              if (resp.status === 200) {
                const data = JSON.parse(resp.text);
                const entry = data[promptId];
                const images = [];
                if (entry?.outputs) {
                  for (const nodeOutput of Object.values(entry.outputs)) {
                    if (nodeOutput.images) for (const img of nodeOutput.images) {
                      images.push(img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename);
                    }
                  }
                }
                resolve(images);
              } else {
                reject(new Error('Failed to get result after WS completion'));
              }
            }).catch(reject);
          }, 500);
        }
      };
      generationCallbacks.set(promptId, { ...wsCallback, onProgress });
    }
    );
  }

  async cancel(promptId) {
    try { await this._request('POST', '/queue', { body: JSON.stringify({ delete: [promptId] }), timeoutMs: 5000 }); } catch {}
  }

  async generateImage(p) {
    const online = await this.healthCheck(5000);
    if (!online) {
      const started = await this.waitForReady(120000);
      if (!started) return 'Error: ComfyUI is not running. Start it first.';
    }

    const denoise = p.denoise ?? 0.55, steps = p.steps ?? 20;
    const seed = p.seed && p.seed !== -1 ? p.seed : Math.floor(Math.random() * 0x7FFFFFFF);
    const width = p.width ?? 1024, height = p.height ?? 1024;

    if (!p.workflowTemplate) return 'Error: workflowTemplate is required.';

    let workflow;
    try {
      const raw = await fs.readFile(p.workflowTemplate, 'utf-8');
      workflow = JSON.parse(raw);
      if (workflow.prompt && typeof workflow.prompt === 'object' && !Array.isArray(workflow.prompt)) {
        workflow = workflow.prompt;
      }
    } catch (err) {
      return `Error: cannot load workflow "${p.workflowTemplate}": ${err.message}`;
    }

    const args = { prompt: p.prompt };
    if (p.denoise !== undefined) args['denoise'] = p.denoise;
    if (p.steps !== undefined) args['steps'] = p.steps;
    if (p.seed !== undefined) args['seed'] = p.seed;
    if (p.width !== undefined) args['width'] = p.width;
    if (p.height !== undefined) args['height'] = p.height;
    this._injectParams(workflow, args);

    if (p.referenceImage) {
      try {
        const uploadedName = await this.uploadImage(p.referenceImage);
        this._injectImage(workflow, uploadedName);
      } catch (err) { return `Error: failed to upload reference image: ${err.message}`; }
    }

    try {
      const promptId = await this.submitWorkflow(workflow);
      const images = await this.waitForResult(promptId);
      if (images.length === 0) return 'Error: ComfyUI produced no output images.';
      const outputDir = p.outputDir || 'F:/ComfyUI/output';
      return images.map(img => path.join(outputDir, img).replace(/\\/g, '/')).join(', ');
    } catch (err) { return `Error: ComfyUI generation failed: ${err.message}`; }
  }

  extractSchema(workflow) {
    const outputNodes = [], modelDeps = [], rawParams = [];
    const posNode = this._findPromptNode(workflow, 'positive');
    const negNode = this._findPromptNode(workflow, 'negative');

    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!node || typeof node !== 'object') continue;
      const n = node;
      const cls = n.class_type || '';
      const inputs = n.inputs || {};

      if (OUTPUT_NODES.has(cls)) outputNodes.push(nodeId);

      for (const pp of PARAM_PATTERNS) {
        if (pp.classType !== cls || !(pp.field in inputs)) continue;
        const value = inputs[pp.field];
        if (isLink(value)) continue;
        let friendlyName = pp.friendlyName;
        if (friendlyName === 'prompt') {
          if (nodeId === negNode && posNode !== negNode) friendlyName = 'negative_prompt';
          else if (nodeId === posNode) friendlyName = 'prompt';
        }
        rawParams.push({ nameHint: friendlyName, nodeId, field: pp.field, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'string', value, classType: cls, friendlyName });
      }

      for (const ml of MODEL_LOADERS) {
        if (ml.classType !== cls || !(ml.field in inputs)) continue;
        const val = inputs[ml.field];
        if (typeof val === 'string' && val) modelDeps.push({ nodeId, classType: cls, field: ml.field, value: val, folder: ml.folder });
      }
    }

    const byName = new Map();
    for (const r of rawParams) { const list = byName.get(r.nameHint) || []; list.push(r); byName.set(r.nameHint, list); }

    const parameters = {};
    for (const [name, entries] of byName) {
      if (entries.length === 1) {
        const { nameHint, ...rest } = entries[0];
        parameters[name] = { ...rest, friendlyName: name };
      } else {
        entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
        for (const e of entries) {
          const fullName = `${name}_${e.nodeId}`;
          const { nameHint, ...rest } = e;
          parameters[fullName] = { ...rest, friendlyName: fullName };
        }
      }
    }

    return { parameters, outputNodes, modelDependencies: modelDeps, summary: { parameterCount: Object.keys(parameters).length, outputNodeCount: outputNodes.length, modelDepCount: modelDeps.length, hasNegativePrompt: 'negative_prompt' in parameters, hasSeed: 'seed' in parameters || Object.keys(parameters).some(k => k.startsWith('seed_')) } };
  }

  async checkDeps(workflow) {
    const schema = this.extractSchema(workflow);
    const lines = [];
    const online = await this.healthCheck(5000);
    if (!online) {
      lines.push('ComfyUI not reachable at ' + this._baseUrl);
      lines.push('Parameters: ' + Object.keys(schema.parameters).join(', '));
      if (schema.modelDependencies.length > 0) lines.push('Required models: ' + schema.modelDependencies.map(m => `${m.value} (${m.folder})`).join(', '));
      return lines.join('\n');
    }
    lines.push(`Schema: ${schema.summary.parameterCount} params, ${schema.summary.modelDepCount} model deps`);
    for (const [name, p] of Object.entries(schema.parameters)) lines.push(`  ${name}: ${p.type} = ${JSON.stringify(p.value)}`);
    if (schema.modelDependencies.length > 0) { lines.push('Models:'); for (const m of schema.modelDependencies) lines.push(`  ${m.value} (${m.folder})`); }
    return lines.join('\n');
  }

  _injectParams(wf, args) {
    for (const [, node] of Object.entries(wf)) {
      const n = node;
      if (!n?.inputs || typeof n.inputs !== 'object') continue;
      const inputs = n.inputs;
      const cls = n.class_type || '';
      for (const pp of PARAM_PATTERNS) {
        if (pp.classType !== cls || !(pp.field in inputs)) continue;
        if (isLink(inputs[pp.field])) continue;
        if (args[pp.friendlyName] !== undefined) inputs[pp.field] = args[pp.friendlyName];
      }
    }
  }

  _injectImage(wf, uploadedName) {
    for (const [, node] of Object.entries(wf)) {
      const n = node;
      if (!n?.inputs || typeof n.inputs !== 'object') continue;
      const inputs = n.inputs;
      if (['LoadImage', 'LoadImageOutput', 'LoadImageMask'].includes(n.class_type || '')) {
        if ('image' in inputs) inputs.image = uploadedName;
      }
    }
  }

  _findPromptNode(workflow, port) {
    for (const [nid, node] of Object.entries(workflow)) {
      if (!node || typeof node !== 'object') continue;
      const n = node;
      if (!SAMPLER_NODE_FAMILY.has(n.class_type || '')) continue;
      const inputs = n.inputs || {};
      const link = inputs[port];
      if (!isLink(link)) continue;
      const src = this._traceToNode(workflow, link[0]);
      if (src) {
        const srcNode = workflow[src];
        const srcCls = srcNode?.class_type || '';
        if (srcCls.startsWith('CLIPTextEncode') || srcCls === 'smZ CLIPTextEncode' || srcCls === 'BNK_CLIPTextEncodeAdvanced') return src;
      }
    }
    return null;
  }

  _traceToNode(workflow, startId, maxHops = 8) {
    const visited = new Set();
    let nid = startId;
    for (let i = 0; i < maxHops && nid; i++) {
      if (visited.has(nid)) return nid;
      visited.add(nid);
      const node = workflow[nid];
      if (!node) return null;
      const cls = node.class_type || '';
      if (!PASSTHROUGH_NODES.has(cls)) return nid;
      const inputs = node.inputs || {};
      const nextLink = Object.values(inputs).find(v => isLink(v));
      if (!nextLink) return nid;
      nid = nextLink[0];
    }
    return nid;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// Process management
// ═══════════════════════════════════════════════════════════════

let comfyProcess = null;
let processLog = [];
const MAX_LOG_LINES = 500;
let processStartTime = null;
let processPid = null;
let serverUrl = DEFAULT_BASE;
let pythonPath = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python312/python.exe';
let comfyDir = 'F:/ComfyUI';
let configLoaded = false;
let generationTimeout = 300;

// WebSocket state for real-time progress
let comfyWs = null;
let wsReconnectTimer = null;
let generationCallbacks = new Map(); // promptId -> { onProgress, onPreview, onComplete }

// ── Plugin config wiring ──
function loadPluginConfig(api) {
  try {
    const conf = api?.configuration?.get ? api.configuration.get('anoclaw-comfyui') : null;
    if (conf) {
      if (conf.serverUrl) serverUrl = conf.serverUrl;
      if (conf.pythonPath) pythonPath = conf.pythonPath;
      if (conf.comfyDir) comfyDir = conf.comfyDir;
      if (conf.timeout) generationTimeout = conf.timeout;
      configLoaded = true;
      api.log.info(`Config loaded: server=${serverUrl}, python=${pythonPath}`);
    }
  } catch {
    // Config not available yet, use defaults
  }
}

// ═══════════════════════════════════════════════════════════════
// WebSocket real-time progress
// ═══════════════════════════════════════════════════════════════

function connectWebSocket() {
  if (comfyWs && comfyWs.readyState === WebSocket.OPEN) return;
  
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  try {
    comfyWs = new WebSocket(wsUrl);
    comfyWs.on('open', () => {
      addLog('WebSocket connected to ComfyUI');
    });
    comfyWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(msg);
      } catch {}
    });
    comfyWs.on('close', () => {
      comfyWs = null;
      // Reconnect after 3 seconds
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    });
    comfyWs.on('error', () => {
      // Will reconnect on close
    });
  } catch {}
}

function handleWsMessage(msg) {
  const { type, data } = msg;
  if (!data) return;
  
  const promptId = data.prompt_id;
  const cb = promptId ? generationCallbacks.get(promptId) : null;
  
  switch (type) {
    case 'execution_start':
      addLog(`Execution started: ${promptId}`);
      break;
    case 'executing':
      if (cb && data.node) {
        addLog(`Node executing: ${data.node}`);
      } else if (cb && data.node === null) {
        // Execution complete
        if (cb.onComplete) cb.onComplete();
        generationCallbacks.delete(promptId);
      }
      break;
    case 'progress':
      if (cb && cb.onProgress) {
        cb.onProgress(data.value || 0, data.max || 0);
      }
      break;
    case 'executed':
      if (cb && data.output && data.output.images) {
        // Images ready
      }
      break;
  }
}

function disconnectWebSocket() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (comfyWs) {
    try { comfyWs.close(); } catch {}
    comfyWs = null;
  }
}

// Kill ComfyUI child process when the app exits (prevents zombies)
function killComfyUIChild() {
  if (comfyProcess) {
    try { comfyProcess.kill('SIGKILL'); } catch { /* already dead */ }
  }
}
process.on('exit', killComfyUIChild);
process.on('SIGTERM', () => { killComfyUIChild(); process.exit(0); });
process.on('SIGINT', () => { killComfyUIChild(); process.exit(0); });

function addLog(line) {
  const ts = new Date().toISOString().slice(11, 23);
  processLog.push(`[${ts}] ${line}`);
  if (processLog.length > MAX_LOG_LINES) {
    processLog.splice(0, processLog.length - MAX_LOG_LINES);
  }
}

function getLogTail(count) {
  return processLog.slice(-count);
}

// ═══════════════════════════════════════════════════════════════
// Plugin lifecycle
// ═══════════════════════════════════════════════════════════════

let api = null;
let comfy = null;

export async function activate(anoclaw) {
  api = anoclaw;
  anoclaw.log.info('ComfyUI plugin activating');
  
  // Load plugin configuration
  loadPluginConfig(anoclaw);
  
  comfy = new ComfyUIService(serverUrl);

  // ── Core workflow tool ──
  await anoclaw.tools.register({
    name: 'Comfy',
    description: 'Manage ComfyUI workflows: inspect schema, generate images, check dependencies, download from GitHub. Supports Flux, SD, SDXL, Wan, Hunyuan, and 156+ node types. Use "download" to fetch community workflows from GitHub (auto-detects format). Use "inspect" to list all controllable parameters. Use "generate" to run image generation. Use "check" to verify model/node availability.',
    parametersSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'generate', 'check', 'download'], description: 'Action to perform' },
        workflowPath: { type: 'string', description: 'Path to workflow JSON file (for inspect/generate/check). For download, save destination.' },
        url: { type: 'string', description: 'GitHub URL to download workflow from (for download)' },
        prompt: { type: 'string', description: 'Text prompt for generation (for generate)' },
        referenceImage: { type: 'string', description: 'Path to local image for img2img' },
        denoise: { type: 'number', description: 'Denoise strength 0.3-1.0' },
        steps: { type: 'number', description: 'Sampling steps (e.g. 20)' },
        seed: { type: 'number', description: 'Random seed, -1 for random' },
        width: { type: 'number', description: 'Image width (e.g. 1024)' },
        height: { type: 'number', description: 'Image height (e.g. 1024)' },
        outputDir: { type: 'string', description: 'Output directory' },
      },
      required: ['action'],
    },
    category: 'Integration',
  });

  // ── Process management tools ──
  await anoclaw.tools.register({
    name: 'startComfyUI',
    description: 'Start the ComfyUI server as a background process. Use this when ComfyUI is not running.',
    parametersSchema: {
      type: 'object',
      properties: {
        pythonPath: { type: 'string', description: 'Python executable path (uses configured default)' },
        comfyDir: { type: 'string', description: 'ComfyUI directory path (uses configured default)' },
        port: { type: 'number', description: 'Port (default: 8188)' },
        listen: { type: 'string', description: 'Listen address (default: 127.0.0.1)' },
      },
    },
    category: 'Image',
  });

  await anoclaw.tools.register({
    name: 'stopComfyUI',
    description: 'Stop the running ComfyUI server process.',
    parametersSchema: { type: 'object', properties: {} },
    category: 'Image',
  });

  await anoclaw.tools.register({
    name: 'getComfyUIStatus',
    description: 'Get ComfyUI server status: process running, connected, log tail, uptime.',
    parametersSchema: { type: 'object', properties: {} },
    category: 'Image',
  });

  await anoclaw.tools.register({
    name: 'getQueueStatus',
    description: 'Check ComfyUI queue status (running/pending jobs).',
    parametersSchema: { type: 'object', properties: {} },
    category: 'Image',
  });

  // ── HTTP routes ──
  await anoclaw.routes.register([
    { method: 'GET', path: '/api/v1/plugins/comfyui/image', handler: 'serveImage' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/process/start', handler: 'processStart' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/process/stop', handler: 'processStop' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/process/status', handler: 'processStatus' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/process/logs', handler: 'processLogs' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/gallery', handler: 'listGallery' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/upload', handler: 'uploadImageProxy' },
  ]);

  // ── Prompt injection ──
  await anoclaw.prompt.inject('comfyui-usage',
    '## ComfyUI Image Generation\n' +
    '- `Comfy` — workflow operations: inspect, generate, check, download (supports Flux, SD, SDXL, 156+ nodes)\n' +
    '- `startComfyUI` / `stopComfyUI` — manage the ComfyUI process\n' +
    '- `getComfyUIStatus` — check process + connection status\n' +
    '- `getQueueStatus` — check ComfyUI queue\n' +
    '- The "ComfyUI" tab has a visual prompt-to-image interface\n',
    45,
  );

  return [{ dispose() { anoclaw.log.info('ComfyUI plugin deactivated'); deactivate(); comfy = null; } }];
}

export async function deactivate() {
  disconnectWebSocket();
  if (comfyProcess) {
    try {
      const pid = processPid;
      if (pid) {
        const { execSync } = await import('child_process');
        execSync(`taskkill //PID ${pid} //F`, { timeout: 3000 });
      }
    } catch { /* ignore */ }
    comfyProcess.kill('SIGTERM');
    comfyProcess = null;
  }
  if (api) {
    api.log.info('ComfyUI plugin deactivated');
    await api.prompt.inject('comfyui-usage', '');
  }
  connected = false;
}

// ═══════════════════════════════════════════════════════════════
// Tool execution
// ═══════════════════════════════════════════════════════════════

let connected = false;

export async function executeTool(toolName, params) {
  switch (toolName) {
    case 'Comfy':
      return executeComfyAction(params);
    case 'startComfyUI':
      return startProcess(params);
    case 'stopComfyUI':
      return stopProcess();
    case 'getComfyUIStatus':
      return getFullStatus();
    case 'getQueueStatus':
      return getQueueStatus();
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function executeComfyAction(params) {
  if (!comfy) comfy = new ComfyUIService();
  const action = params.action;
  try {
    switch (action) {
      case 'download': return await handleDownload(params);
      case 'inspect': return await handleInspect(params);
      case 'generate': return await handleGenerate(params);
      case 'check': return await handleCheck(params);
      default: return `Unknown action: ${action}. Use download, inspect, generate, or check.`;
    }
  } catch (err) { return `ComfyUI error: ${err.message}`; }
}

// ═══════════════════════════════════════════════════════════════
// Comfy action handlers
// ═══════════════════════════════════════════════════════════════

async function handleDownload(params) {
  const url = params.url;
  const savePath = params.workflowPath;
  if (!url) return 'Error: url is required for download.';
  if (!savePath) return 'Error: workflowPath is required for download.';

  let rawUrl = url;
  const blobMatch = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/);
  if (blobMatch) rawUrl = `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/refs/heads/${blobMatch[3]}`;

  let text;
  try {
    const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
    text = await resp.text();
  } catch (err) { return `Error: download failed: ${err.message}`; }

  const trimmed = text.trim();
  if (trimmed.startsWith('\x89PNG') || trimmed.startsWith('�PNG')) {
    return 'Error: This is a PNG with embedded workflow metadata. Load it into ComfyUI web UI and Export → API format.';
  }

  let workflow, format;
  try {
    const parsed = JSON.parse(trimmed);
    if ('nodes' in parsed && 'links' in parsed) {
      const converted = editorToApi(parsed);
      if (!converted) return 'Error: Cannot auto-convert editor format. Load into ComfyUI web UI and Export → API.';
      workflow = converted; format = 'editor (auto-converted)';
    } else if (parsed.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)) {
      workflow = parsed.prompt; format = 'API (unwrapped)';
    } else {
      let hasClassType = false;
      for (const v of Object.values(parsed)) { if (v && typeof v === 'object' && 'class_type' in v) { hasClassType = true; break; } }
      if (hasClassType) { workflow = parsed; format = 'API'; }
      else return 'Error: Unrecognized workflow format. Got keys: ' + Object.keys(parsed).slice(0, 10).join(', ');
    }
  } catch { return 'Error: File is not valid JSON.'; }

  let nodeCount = 0;
  for (const v of Object.values(workflow)) { if (v && typeof v === 'object' && 'class_type' in v) nodeCount++; }
  if (nodeCount === 0) return 'Error: No ComfyUI nodes found.';

  await fs.mkdir(path.dirname(path.resolve(savePath)), { recursive: true });
  await fs.writeFile(path.resolve(savePath), JSON.stringify(workflow, null, 2), 'utf-8');

  const schema = comfy.extractSchema(workflow);
  const modelNames = schema.modelDependencies.map(m => m.value).join(', ');
  const paramNames = Object.keys(schema.parameters).join(', ');
  return `Downloaded → ${path.resolve(savePath)}\nFormat: ${format}. Nodes: ${nodeCount}. ${schema.summary.parameterCount} params, ${schema.summary.modelDepCount} deps.\nModels: ${modelNames || '(none)'}\nParams: ${paramNames || '(none)'}`;
}

function editorToApi(editor) {
  const nodes = editor.nodes;
  const links = editor.links;
  if (!Array.isArray(nodes)) return null;
  const api = {};
  const idMap = new Map();
  for (const n of nodes) {
    const apiId = String(Object.keys(api).length + 1);
    idMap.set(Number(n.id), apiId);
    const inputs = {};
    const widgets = n.widgets_values;
    if (Array.isArray(widgets)) {
      const fieldNames = widgetFields(n.type || '');
      for (let i = 0; i < widgets.length; i++) inputs[fieldNames[i] || `param_${i}`] = widgets[i];
    }
    api[apiId] = { class_type: n.type || '', inputs, _meta: { title: n.title || n.type || '' } };
  }
  if (Array.isArray(links)) {
    for (const link of links) {
      if (!Array.isArray(link) || link.length < 4) continue;
      const [srcId, srcSlot, dstId, dstSlot] = link;
      const dstApi = api[idMap.get(dstId)];
      if (!dstApi) continue;
      const fieldNames = widgetFields(dstApi.class_type || '');
      (dstApi.inputs)[fieldNames[dstSlot] || `param_${dstSlot}`] = [String(idMap.get(srcId)), srcSlot];
    }
  }
  return api;
}

const _WIDGET_FIELDS = {
  CheckpointLoaderSimple: ['ckpt_name'],
  CLIPTextEncode: ['text'], CLIPTextEncodeSDXL: ['text_g', 'text_l'],
  CLIPTextEncodeFlux: ['clip_l', 't5xxl', 'guidance'],
  KSampler: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  SaveImage: ['filename_prefix'], VAELoader: ['vae_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],
  LoraLoader: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'],
  LoadImage: ['image'], VAEDecode: ['samples', 'vae'], VAEEncode: ['pixels', 'vae'],
  BasicScheduler: ['model', 'scheduler', 'steps', 'denoise'],
  RandomNoise: ['noise_seed'], KSamplerSelect: ['sampler_name'],
  SamplerCustom: ['noise_seed', 'cfg', 'sampler', 'sigmas', 'guider', 'sampler_name'],
  CFGGuider: ['model', 'positive', 'negative', 'cfg'],
  ModelSamplingFlux: ['model', 'max_shift', 'base_shift', 'width', 'height'],
  FluxGuidance: ['conditioning', 'guidance'],
};
function widgetFields(classType) { return _WIDGET_FIELDS[classType] || []; }

async function handleInspect(params) {
  const wfPath = params.workflowPath;
  if (!wfPath) return 'Error: workflowPath is required.';

  let workflow;
  try {
    const raw = await fs.readFile(wfPath, 'utf-8');
    workflow = JSON.parse(raw);
    if (workflow.prompt && typeof workflow.prompt === 'object' && !Array.isArray(workflow.prompt)) workflow = workflow.prompt;
  } catch (err) { return `Error: ${err.message}`; }

  const schema = comfy.extractSchema(workflow);
  const paramList = Object.entries(schema.parameters)
    .map(([name, p]) => `  ${name} = ${JSON.stringify(p.value)} (${p.type}, node ${p.nodeId}.${p.field})`).join('\n');
  let models = '';
  if (schema.modelDependencies.length > 0) {
    models = '\n\nModel dependencies:\n' + schema.modelDependencies.map(m => `  ${m.value} (${m.folder})`).join('\n');
  }
  return `Workflow "${wfPath}": ${schema.summary.parameterCount} params, ${schema.summary.outputNodeCount} outputs, ${schema.summary.modelDepCount} deps.\n\nParameters:\n${paramList}${models}`;
}

async function handleGenerate(params) {
  if (!params.workflowPath) return 'Error: workflowPath is required.';
  if (!params.prompt) return 'Error: prompt is required.';
  return await comfy.generateImage({
    prompt: params.prompt, workflowTemplate: params.workflowPath,
    referenceImage: params.referenceImage, denoise: params.denoise,
    steps: params.steps, seed: params.seed, width: params.width, height: params.height,
    outputDir: params.outputDir,
  });
}

async function handleCheck(params) {
  const wfPath = params.workflowPath;
  if (!wfPath) return 'Error: workflowPath is required.';
  const online = await comfy.healthCheck();
  if (!online) {
    try {
      const raw = await fs.readFile(wfPath, 'utf-8');
      let wf = JSON.parse(raw);
      if (wf.prompt && typeof wf.prompt === 'object' && !Array.isArray(wf.prompt)) wf = wf.prompt;
      const schema = comfy.extractSchema(wf);
      return `ComfyUI offline. Workflow: ${schema.summary.parameterCount} params. Params: ${Object.keys(schema.parameters).join(', ')}`;
    } catch (err) { return `Cannot analyze: ${err.message}`; }
  }
  const raw = await fs.readFile(wfPath, 'utf-8');
  let workflow = JSON.parse(raw);
  if (workflow.prompt && typeof workflow.prompt === 'object' && !Array.isArray(workflow.prompt)) workflow = workflow.prompt;
  return await comfy.checkDeps(workflow);
}

// ═══════════════════════════════════════════════════════════════
// Process management tools
// ═══════════════════════════════════════════════════════════════

async function startProcess(params) {
  if (comfyProcess && comfyProcess.exitCode === null) {
    return JSON.stringify({
      error: 'ComfyUI is already running', pid: processPid,
      uptime: processStartTime ? Math.round((Date.now() - processStartTime) / 1000) + 's' : '?',
    }, null, 2);
  }
  comfyProcess = null;

  const python = params.pythonPath || pythonPath;
  const cwd = params.comfyDir || comfyDir;
  const port = params.port || 8188;
  const listen = params.listen || '127.0.0.1';

  serverUrl = `http://${listen}:${port}`;
  comfy = new ComfyUIService(serverUrl);
  processLog = [];
  processStartTime = null;
  processPid = null;

  return new Promise((resolve) => {
    addLog(`Starting ComfyUI: ${python} ${cwd}\\main.py --listen ${listen} --port ${port}`);

    try {
      const child = spawn(python, ['main.py', '--listen', listen, '--port', String(port)], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });

      comfyProcess = child;
      processPid = child.pid || null;
      processStartTime = Date.now();

      child.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        if (text) addLog(text);
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        if (text) addLog(`[err] ${text}`);
      });

      child.on('error', (err) => {
        addLog(`[ERROR] Failed to start: ${err.message}`);
        connected = false; comfyProcess = null; processPid = null; processStartTime = null;
        resolve(JSON.stringify({ error: `Failed to start: ${err.message}` }, null, 2));
      });

      child.on('exit', (code, signal) => {
        addLog(`Process exited (code=${code}, signal=${signal})`);
        comfyProcess = null; processPid = null; connected = false;
      });

      setTimeout(async () => {
        connected = await testConnection();
        resolve(JSON.stringify({
          started: true, pid: processPid, connected, command: `${python} main.py --listen ${listen} --port ${port}`, cwd,
          message: connected ? 'ComfyUI started and responding' : 'ComfyUI process launched (waiting for server — check logs)',
          logTail: getLogTail(10),
        }, null, 2));
      }, 3000);
    } catch (err) {
      addLog(`[ERROR] Spawn failed: ${err.message}`);
      resolve(JSON.stringify({ error: `Spawn failed: ${err.message}` }, null, 2));
    }
  });
}

async function stopProcess() {
  if (!comfyProcess && !processPid) {
    return JSON.stringify({ error: 'No ComfyUI process is running' }, null, 2);
  }

  addLog('Stopping ComfyUI...');

  if (comfyProcess) {
    try {
      const pid = processPid;
      if (pid) {
        const { execSync } = await import('child_process');
        execSync(`taskkill //PID ${pid} //F`, { timeout: 3000 });
      }
    } catch { /* ignore */ }
    comfyProcess.kill('SIGTERM');
  }

  comfyProcess = null;
  processPid = null;
  connected = false;

  addLog('ComfyUI stopped');
  return JSON.stringify({ stopped: true }, null, 2);
}

async function getFullStatus() {
  connected = await testConnection();
  const isProcessRunning = comfyProcess !== null && comfyProcess.exitCode === null;
  const uptime = processStartTime ? `${Math.round((Date.now() - processStartTime) / 1000)}s` : null;

  const result = {
    process: isProcessRunning ? 'running' : 'stopped',
    connected, serverUrl, pid: processPid,
    uptime, processLogCount: processLog.length,
    logTail: getLogTail(5),
  };

  return JSON.stringify(result, null, 2);
}

async function testConnection() {
  try {
    const resp = await fetch(`${serverUrl}/queue`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function getQueueStatus() {
  try {
    const resp = await fetch(`${serverUrl}/queue`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`Failed: ${resp.status}`);
    const data = await resp.json();
    return JSON.stringify({
      running: (data.queue_running || []).length,
      pending: (data.queue_pending || []).length,
      total: (data.queue_running || []).length + (data.queue_pending || []).length,
    }, null, 2);
  } catch (err) {
    connected = false;
    return JSON.stringify({ error: `Queue check failed: ${err.message}` }, null, 2);
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP route handlers
// ═══════════════════════════════════════════════════════════════

export async function processStart(request) {
  try {
    const body = request.body || {};
    const result = await startProcess(body);
    return { status: 200, body: JSON.parse(result) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function processStop() {
  try {
    const result = await stopProcess();
    return { status: 200, body: JSON.parse(result) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function processStatus() {
  connected = await testConnection();
  const isRunning = comfyProcess !== null && comfyProcess.exitCode === null;
  return {
    status: 200,
    body: {
      process: isRunning ? 'running' : (comfyProcess ? 'exited' : 'stopped'),
      connected, serverUrl, pid: processPid,
      uptime: processStartTime ? Math.round((Date.now() - processStartTime) / 1000) : null,
      logCount: processLog.length,
    },
  };
}

export async function processLogs(request) {
  const q = new URLSearchParams(request.query || '');
  const tail = parseInt(q.get('tail') || '50', 10);
  return { status: 200, body: { lines: getLogTail(tail), total: processLog.length } };
}

export async function serveImage(request) {
  const q = new URLSearchParams(request.query || '');
  const filename = q.get('filename');
  const type = q.get('type') || 'output';
  const subfolder = q.get('subfolder') || '';

  if (!filename) return { status: 400, body: { error: 'filename required' } };

  // Path traversal protection: reject filenames with .. or / or \
  if (/[.][.]/.test(filename) || /[\\/]/.test(filename)) {
    return { status: 400, body: { error: 'Invalid filename' } };
  }
  if (subfolder && (/[.][.]/.test(subfolder) || /[\\]/.test(subfolder))) {
    return { status: 400, body: { error: 'Invalid subfolder' } };
  }
  // Only allow safe characters in filename
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return { status: 400, body: { error: 'Invalid filename characters' } };
  }

  try {
    const resp = await fetch(`${serverUrl}/view?filename=${encodeURIComponent(filename)}&type=${type}&subfolder=${encodeURIComponent(subfolder)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { status: 502, body: { error: `ComfyUI returned ${resp.status}` } };

    const blob = await resp.blob();
    const buffer = await blob.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mime = resp.headers.get('content-type') || 'image/png';

    return { status: 200, body: { image: `data:${mime};base64,${base64}`, mimeType: mime } };
  } catch (err) {
    return { status: 502, body: { error: `Failed to fetch: ${err.message}` } };
  }
}

export async function listGallery(request) {
  const q = new URLSearchParams(request.query || '');
  const limit = parseInt(q.get('limit') || '50', 10);
  const outputDir = q.get('dir') || DEFAULT_OUTPUT_DIR;
  
  try {
    const files = await fs.readdir(outputDir);
    const images = files
      .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
    
    // Get file stats for sorting
    const withStats = await Promise.all(images.map(async f => {
      try {
        const stat = await fs.stat(path.join(outputDir, f));
        return { filename: f, mtime: stat.mtimeMs, size: stat.size };
      } catch {
        return { filename: f, mtime: 0, size: 0 };
      }
    }));
    
    withStats.sort((a, b) => b.mtime - a.mtime);
    
    const result = withStats.slice(0, limit).map(item => ({
      filename: item.filename,
      url: `/api/v1/plugins/comfyui/image?filename=${encodeURIComponent(item.filename)}&type=output`,
      size: item.size,
      mtime: item.mtime,
    }));
    
    return { status: 200, body: { images: result, total: images.length } };
  } catch (err) {
    return { status: 200, body: { images: [], total: 0, error: err.message } };
  }
}

export async function uploadImageProxy(request) {
  try {
    const body = request.body;
    if (!body || !body.filename || !body.data) {
      return { status: 400, body: { error: 'filename and data (base64) required' } };
    }
    
    // Sanitize filename
    const filename = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const buffer = Buffer.from(body.data, 'base64');
    
    // Write to ComfyUI input directory
    const inputDir = path.join(comfyDir, 'input');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, filename), buffer);
    
    return { status: 200, body: { name: filename, size: buffer.length } };
  } catch (err) {
    return { status: 500, body: { error: `Upload failed: ${err.message}` } };
  }
}
