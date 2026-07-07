// extension.js - ComfyUI plugin v2.1 (merged)
// Core: workflow inspection, generation, dependency checking, GitHub download.
// Process management: start/stop/monitor ComfyUI as a subprocess.
// Frontend: visual prompt-to-image interface.
// HTTP routes: image proxy, process management API.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
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

function queueContainsPrompt(items, promptId) {
  return Array.isArray(items) && items.some(item => JSON.stringify(item).includes(promptId));
}

// ═══════════════════════════════════════════════════════════════
// ComfyUIService (inlined from kernel)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_BASE = 'http://127.0.0.1:8188';
const COMMUNITY_WORKFLOW_SOURCES = [
  {
    id: 'comfy-org-templates',
    title: 'Comfy Org workflow templates',
    provider: 'github',
    region: 'global',
    url: 'https://github.com/Comfy-Org/workflow_templates',
    tags: ['official', 'image', 'video', 'flux', 'sdxl', 'wan'],
  },
  {
    id: 'comfy-org-examples',
    title: 'Comfy Org example workflows',
    provider: 'github',
    region: 'global',
    url: 'https://github.com/Comfy-Org/example_workflows',
    tags: ['official', 'examples', 'image', 'video'],
  },
  {
    id: 'comfyui-examples',
    title: 'ComfyUI example workflows',
    provider: 'github',
    region: 'global',
    url: 'https://github.com/comfyanonymous/ComfyUI_examples',
    tags: ['official', 'examples', 'image', 'api'],
  },
  {
    id: 'community-direct',
    title: 'Custom community URL',
    provider: 'auto',
    region: 'global-cn',
    url: '',
    tags: ['github', 'gitee', 'raw-json', 'webpage'],
  },
];
const COMFY_DIR_CANDIDATES = [
  process.env.COMFYUI_DIR,
  process.env.COMFYUI_PATH,
  'F:/ComfyUI',
  'D:/ComfyUI',
  'C:/ComfyUI',
].filter(Boolean);
const SUPPORTED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.avi']);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi']);
const JOB_HISTORY_DIR = 'F:/QoderSoft/AnoClaw/plugins/anoclaw-comfyui/data/jobs';
const TRAINING_JOB_DIR = 'F:/QoderSoft/AnoClaw/plugins/anoclaw-comfyui/data/training/jobs';
const MODEL_DOWNLOAD_DIR = 'F:/QoderSoft/AnoClaw/plugins/anoclaw-comfyui/data/model-downloads';
const MODEL_FOLDER_ALIASES = {
  checkpoints: ['checkpoints'],
  unet: ['unet', 'diffusion_models'],
  diffusion_models: ['diffusion_models', 'unet'],
  vae: ['vae'],
  clip: ['clip'],
  loras: ['loras', 'lora'],
  controlnet: ['controlnet', 'control_net'],
  upscale_models: ['upscale_models'],
  input: ['input'],
};

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

  async objectInfo(timeoutMs = 10000) {
    const resp = await this._request('GET', '/object_info', { timeoutMs });
    if (resp.status !== 200) throw new Error(`object_info failed: ${resp.status}`);
    return JSON.parse(resp.text || '{}');
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
          const images = this._collectOutputNames(entry.outputs);
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
                const images = entry?.outputs ? this._collectOutputNames(entry.outputs) : [];
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

  async getPromptStatus(promptId, outputDir = getDefaultOutputDir()) {
    const historyResp = await this._request('GET', `/history/${promptId}`, { timeoutMs: 10000 });
    if (historyResp.status === 200) {
      const history = JSON.parse(historyResp.text || '{}');
      const entry = history[promptId];
      if (entry?.outputs) {
        const outputs = this._collectOutputNames(entry.outputs).map(item => path.join(outputDir, item).replace(/\\/g, '/'));
        return { promptId, status: 'completed', outputs, outputCount: outputs.length, history: entry };
      }
    }

    const queueResp = await this._request('GET', '/queue', { timeoutMs: 10000 });
    if (queueResp.status === 200) {
      const queue = JSON.parse(queueResp.text || '{}');
      if (queueContainsPrompt(queue.queue_running, promptId)) return { promptId, status: 'running', outputs: [], queue };
      if (queueContainsPrompt(queue.queue_pending, promptId)) return { promptId, status: 'pending', outputs: [], queue };
    }

    return { promptId, status: 'not_found', outputs: [] };
  }

  _collectOutputNames(outputs) {
    const files = [];
    for (const nodeOutput of Object.values(outputs || {})) {
      for (const key of ['images', 'gifs', 'videos', 'animated', 'audio', 'files']) {
        if (!Array.isArray(nodeOutput[key])) continue;
        for (const item of nodeOutput[key]) {
          if (item?.filename) files.push(item.subfolder ? `${item.subfolder}/${item.filename}` : item.filename);
        }
      }
    }
    return files;
  }

  async prepareWorkflow(p) {
    const denoise = p.denoise ?? 0.55, steps = p.steps ?? 20;
    const seed = p.seed && p.seed !== -1 ? p.seed : Math.floor(Math.random() * 0x7FFFFFFF);
    const width = p.width ?? 1024, height = p.height ?? 1024;

    if (!p.workflowTemplate) throw new Error('workflowTemplate is required.');

    let workflow;
    try {
      const raw = await fs.readFile(p.workflowTemplate, 'utf-8');
      const normalized = normalizeWorkflowObject(JSON.parse(raw));
      if (!normalized.workflow) throw new Error(normalized.error || 'unrecognized workflow format.');
      workflow = normalized.workflow;
    } catch (err) {
      throw new Error(`cannot load workflow "${p.workflowTemplate}": ${err.message}`);
    }

    const args = { prompt: p.prompt };
    if (p.negativePrompt !== undefined) args['negative_prompt'] = p.negativePrompt;
    if (p.denoise !== undefined) args['denoise'] = p.denoise;
    if (p.steps !== undefined) args['steps'] = p.steps;
    if (p.seed !== undefined) args['seed'] = p.seed;
    if (p.width !== undefined) args['width'] = p.width;
    if (p.height !== undefined) args['height'] = p.height;
    if (p.extraParams && typeof p.extraParams === 'object') Object.assign(args, p.extraParams);
    this._injectParams(workflow, args);
    this._injectNamedParams(workflow, args);

    if (p.referenceImage) {
      try {
        const uploadedName = await this.uploadImage(p.referenceImage);
        this._injectImage(workflow, uploadedName);
      } catch (err) { throw new Error(`failed to upload reference image: ${err.message}`); }
    }

    return { workflow, seed, steps, denoise, width, height };
  }

  async generateImage(p) {
    const online = await this.healthCheck(5000);
    if (!online) {
      const started = await this.waitForReady(120000);
      if (!started) return 'Error: ComfyUI is not running. Start it first.';
    }

    try {
      const prepared = await this.prepareWorkflow(p);
      const workflow = prepared.workflow;
      const promptId = await this.submitWorkflow(workflow);
      const images = await this.waitForResult(promptId);
      if (images.length === 0) return 'Error: ComfyUI produced no output images.';
      const outputDir = p.outputDir || getDefaultOutputDir();
      return images.map(img => path.join(outputDir, img).replace(/\\/g, '/')).join(', ');
    } catch (err) { return `Error: ComfyUI generation failed: ${err.message}`; }
    finally { disconnectWebSocket(); }
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

  _injectNamedParams(wf, args) {
    const schema = this.extractSchema(wf);
    for (const [name, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      const target = schema.parameters[name];
      if (!target) continue;
      const node = wf[target.nodeId];
      if (node?.inputs && !isLink(node.inputs[target.field])) {
        node.inputs[target.field] = value;
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

function detectComfyDir() {
  for (const candidate of COMFY_DIR_CANDIDATES) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (existsSync(path.join(resolved, 'main.py'))) return resolved;
  }
  return path.resolve(COMFY_DIR_CANDIDATES[0] || 'ComfyUI');
}

function getComfyDir() {
  if (!comfyDir) comfyDir = detectComfyDir();
  return comfyDir;
}

function getDefaultOutputDir() {
  return path.join(getComfyDir(), 'output');
}

function getDefaultWorkflowDirs() {
  return [
    path.join(getComfyDir(), 'user', 'default', 'workflows'),
    path.join(getComfyDir(), 'workflows'),
    path.join(getPluginDir(), 'workflows'),
  ];
}

// ═══════════════════════════════════════════════════════════════
// Process management
// ═══════════════════════════════════════════════════════════════

let comfyProcess = null;
let processLog = [];
const MAX_LOG_LINES = 500;
let processStartTime = null;
let processPid = null;
const trainingProcesses = new Map();
let serverUrl = DEFAULT_BASE;
let pythonPath = 'C:/Users/Administrator/AppData/Local/Programs/Python/Python312/python.exe';
let comfyDir = '';
let configLoaded = false;
let generationTimeout = 300;

// WebSocket state for real-time progress
let comfyWs = null;
let wsReconnectTimer = null;
let wsReconnectEnabled = false;
let generationCallbacks = new Map(); // promptId -> { onProgress, onPreview, onComplete }

// ── Plugin config wiring ──
function loadPluginConfig(api) {
  try {
    const conf = api?.configuration?.get ? api.configuration.get('anoclaw-comfyui') : null;
    if (conf) {
      if (conf.serverUrl) serverUrl = conf.serverUrl;
      if (conf.pythonPath) pythonPath = conf.pythonPath;
      if (conf.comfyDir) comfyDir = path.resolve(conf.comfyDir);
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
    wsReconnectEnabled = true;
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
      if (wsReconnectEnabled) {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
      }
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
  wsReconnectEnabled = false;
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

async function refreshComfyUISlot() {
  if (!api?.ui?.mount) return;
  const isRunning = comfyProcess !== null && comfyProcess.exitCode === null;
  let isConnected = connected;

  try {
    isConnected = await testConnection();
  } catch {
    isConnected = false;
  }

  const value = isConnected ? 'online' : (isRunning ? 'starting' : 'offline');
  const tone = isConnected ? 'ok' : (isRunning ? 'warn' : 'danger');
  await mountSlotBadge(api, 'Comfy', value, tone, 'comfyui-status', 48);
}

async function mountSlotBadge(anoclaw, label, value, tone, id, priority = 50) {
  const html =
    `<span class="anoclaw-slot-pill" data-tone="${tone}">` +
    '<span class="slot-dot"></span>' +
    `<strong>${escapeSlot(label)}</strong>` +
    `<span>${escapeSlot(value)}</span>` +
    '</span>';

  try {
    await anoclaw.ui.mount('titlebar-right', html, {
      id,
      priority,
      position: 'append',
      replace: true,
    });
  } catch (err) {
    anoclaw.log.warn(`Failed to mount ComfyUI slot badge: ${err.message}`);
  }
}

function escapeSlot(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// Plugin lifecycle
// ═══════════════════════════════════════════════════════════════

let api = null;
let comfy = null;

async function registerComfyAutomationTools(anoclaw) {
  const category = 'Image';
  await anoclaw.tools.register({
    name: 'comfyGenerateAsset',
    description: 'Generate an image, GIF, or video asset through a ComfyUI API-format workflow. Can enhance a brief into a production prompt, inject prompt/negative_prompt/seed/steps/width/height and extra named workflow parameters, optionally start ComfyUI, wait for completion, and return output file paths.',
    parametersSchema: {
      type: 'object',
      properties: {
        workflowPath: { type: 'string', description: 'API-format ComfyUI workflow JSON path. Use comfyListWorkflows first if unknown.' },
        brief: { type: 'string', description: 'Short creative brief from the user or agent.' },
        prompt: { type: 'string', description: 'Ready-to-run positive prompt. If omitted, brief is enhanced.' },
        negativePrompt: { type: 'string', description: 'Negative prompt or exclusions.' },
        kind: { type: 'string', enum: ['image', 'video', 'animation'], description: 'Expected output kind.' },
        referenceImage: { type: 'string', description: 'Optional local reference image path for img2img workflows.' },
        autoEnhance: { type: 'boolean', description: 'Enhance brief with LLM before generation. Default true when prompt is omitted.' },
        autoStart: { type: 'boolean', description: 'Start local ComfyUI if not reachable.' },
        steps: { type: 'number' },
        seed: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        denoise: { type: 'number' },
        outputDir: { type: 'string' },
        extraParams: { type: 'object', description: 'Additional workflow schema parameters by name, e.g. guidance or lora_name_23.' },
      },
      required: ['workflowPath'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfySubmitJob',
    description: 'Submit a ComfyUI workflow as an asynchronous job and return immediately with jobId and promptId. Use this for video or long-running image workflows, then poll with comfyGetJobStatus.',
    parametersSchema: {
      type: 'object',
      properties: {
        workflowPath: { type: 'string', description: 'API-format ComfyUI workflow JSON path.' },
        brief: { type: 'string', description: 'Short creative brief. Used to enhance prompt when prompt is omitted.' },
        prompt: { type: 'string' },
        negativePrompt: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video', 'animation'] },
        referenceImage: { type: 'string' },
        autoStart: { type: 'boolean' },
        steps: { type: 'number' },
        seed: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        denoise: { type: 'number' },
        outputDir: { type: 'string' },
        extraParams: { type: 'object' },
      },
      required: ['workflowPath'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyGetJobStatus',
    description: 'Get status for an async ComfyUI job created by comfySubmitJob, or for a raw ComfyUI promptId. Updates the persisted job manifest when completed.',
    parametersSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        promptId: { type: 'string' },
        outputDir: { type: 'string' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyCancelJob',
    description: 'Cancel a pending ComfyUI async job by jobId or promptId and mark the job manifest as cancelled.',
    parametersSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        promptId: { type: 'string' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyEnhancePrompt',
    description: 'Turn a rough user brief into a high-quality ComfyUI production prompt plus negative prompt.',
    parametersSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'Creative brief.' },
        kind: { type: 'string', enum: ['image', 'video', 'animation'], description: 'Target media kind.' },
        style: { type: 'string', description: 'Style, genre, camera, rendering, or brand direction.' },
        constraints: { type: 'string', description: 'Hard requirements to keep.' },
      },
      required: ['brief'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListWorkflows',
    description: 'List available ComfyUI workflow JSON files with schema summaries and model dependencies.',
    parametersSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Optional workflow directory to scan recursively.' },
        query: { type: 'string', description: 'Optional filename/path filter.' },
        limit: { type: 'number', description: 'Maximum workflows to return.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyImportWorkflow',
    description: 'Import a ComfyUI workflow from a GitHub/raw URL or local JSON into the plugin workflow library.',
    parametersSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub blob/raw URL.' },
        sourcePath: { type: 'string', description: 'Local workflow JSON path.' },
        name: { type: 'string', description: 'Library filename without extension.' },
        workflowPath: { type: 'string', description: 'Explicit destination path.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyDiscoverGithubWorkflows',
    description: 'Discover ComfyUI workflow JSON files from a GitHub repository, tree URL, directory URL, or blob/raw URL. Returns candidates with import readiness without saving files.',
    parametersSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub repo/tree/blob/raw URL.' },
        ref: { type: 'string', description: 'Optional branch/tag/commit override.' },
        path: { type: 'string', description: 'Optional repository subdirectory.' },
        recursive: { type: 'boolean', description: 'Scan nested directories. Default true.' },
        limit: { type: 'number', description: 'Maximum JSON files to inspect.' },
      },
      required: ['url'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyImportGithubWorkflows',
    description: 'Discover and import multiple ComfyUI workflow JSON files from GitHub into the plugin workflow library. Supports repo/tree/directory/blob/raw URLs.',
    parametersSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub repo/tree/blob/raw URL.' },
        ref: { type: 'string', description: 'Optional branch/tag/commit override.' },
        path: { type: 'string', description: 'Optional repository subdirectory.' },
        recursive: { type: 'boolean', description: 'Scan nested directories. Default true.' },
        limit: { type: 'number', description: 'Maximum workflows to import.' },
        destinationDir: { type: 'string', description: 'Destination directory. Defaults to plugin workflows/github.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing files.' },
      },
      required: ['url'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListWorkflowSources',
    description: 'List built-in ComfyUI community workflow sources that agents can use for diverse image, video, Flux, SDXL, and automation workflows.',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional source title/tag/provider/region filter.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyDiscoverCommunityWorkflows',
    description: 'Discover ComfyUI workflow JSON files from built-in community sources, GitHub, Gitee, direct JSON URLs, or public pages that link JSON workflows. Returns candidates without saving files.',
    parametersSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Built-in source id from comfyListWorkflowSources.' },
        url: { type: 'string', description: 'GitHub/Gitee repository, tree, raw JSON, or webpage URL.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Multiple community URLs to scan.' },
        ref: { type: 'string', description: 'Optional branch/tag/commit override for repository providers.' },
        path: { type: 'string', description: 'Optional repository subdirectory.' },
        recursive: { type: 'boolean', description: 'Scan nested directories. Default true.' },
        limit: { type: 'number', description: 'Maximum JSON files to inspect per source.' },
        query: { type: 'string', description: 'Optional filename/path/title filter.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyImportCommunityWorkflows',
    description: 'Import diverse ComfyUI workflows from built-in community sources, GitHub, Gitee, direct JSON URLs, or public workflow pages into the plugin workflow library.',
    parametersSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Built-in source id from comfyListWorkflowSources.' },
        url: { type: 'string', description: 'GitHub/Gitee repository, tree, raw JSON, or webpage URL.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Multiple community URLs to scan.' },
        ref: { type: 'string', description: 'Optional branch/tag/commit override for repository providers.' },
        path: { type: 'string', description: 'Optional repository subdirectory.' },
        recursive: { type: 'boolean', description: 'Scan nested directories. Default true.' },
        limit: { type: 'number', description: 'Maximum workflows to import per source.' },
        query: { type: 'string', description: 'Optional filename/path/title filter.' },
        destinationDir: { type: 'string', description: 'Destination directory. Defaults to plugin workflows/community/<source>.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing files.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyValidateWorkflow',
    description: 'Validate a local ComfyUI workflow for agent execution. Reports controllable parameters, output nodes, model file availability, required input images, and whether the workflow can be submitted.',
    parametersSchema: {
      type: 'object',
      properties: {
        workflowPath: { type: 'string', description: 'Workflow JSON path.' },
        referenceImage: { type: 'string', description: 'Optional local image that will satisfy LoadImage nodes.' },
        extraParams: { type: 'object', description: 'Optional parameter overrides to validate by name.' },
      },
      required: ['workflowPath'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListOutputs',
    description: 'List recent ComfyUI output assets, including images, GIFs, and videos.',
    parametersSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Output directory. Defaults to the configured ComfyUI output directory.' },
        query: { type: 'string', description: 'Optional filename filter.' },
        limit: { type: 'number', description: 'Maximum assets.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListModels',
    description: 'List local ComfyUI model files grouped by model folder.',
    parametersSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Optional model folder filter, e.g. checkpoints, unet, diffusion_models, vae, clip, loras, controlnet.' },
        query: { type: 'string', description: 'Optional filename filter.' },
        limit: { type: 'number', description: 'Maximum models.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyDownloadModel',
    description: 'Download a model file into a guarded ComfyUI models subdirectory. Requires confirm:true unless dryRun:true. Supports direct HTTP(S), HuggingFace, and Civitai URLs when they are already authorized.',
    parametersSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct model download URL.' },
        folder: { type: 'string', description: 'Target ComfyUI models folder: checkpoints, unet, diffusion_models, vae, clip, loras, controlnet, upscale_models.' },
        filename: { type: 'string', description: 'Optional destination filename. Defaults to URL filename.' },
        overwrite: { type: 'boolean' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        headers: { type: 'object', description: 'Optional request headers, e.g. Authorization for private model endpoints.' },
      },
      required: ['url', 'folder'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListJobs',
    description: 'List persisted ComfyUI automation jobs created by comfyGenerateAsset, including prompt, workflow, outputs, diagnostics, and errors.',
    parametersSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter, e.g. completed, failed.' },
        query: { type: 'string', description: 'Optional text filter over prompt, workflow, or output paths.' },
        limit: { type: 'number', description: 'Maximum jobs to return.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyTagDataset',
    description: 'Create caption/tag sidecar files for a local image dataset to prepare LoRA or targeted model training.',
    parametersSchema: {
      type: 'object',
      properties: {
        datasetDir: { type: 'string', description: 'Directory containing training images.' },
        baseTags: { type: 'array', items: { type: 'string' }, description: 'Tags applied to every image.' },
        triggerWord: { type: 'string', description: 'Training trigger word to prepend.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing .txt captions.' },
        useJobPrompts: { type: 'boolean', description: 'Use comfyGenerateAsset job prompt when the image came from a recorded job. Default true.' },
        useComfyMetadata: { type: 'boolean', description: 'Use ComfyUI PNG prompt/workflow metadata when available. Default true.' },
        includeFileTags: { type: 'boolean', description: 'Include filename and folder-derived tags. Default true.' },
        captionStyle: { type: 'string', enum: ['tags', 'sentence'], description: 'Write comma tags or a sentence-like caption. Default tags.' },
        limit: { type: 'number', description: 'Maximum images to tag.' },
      },
      required: ['datasetDir'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyPrepareTrainingJob',
    description: 'Create a structured, reviewable training job manifest for LoRA or other targeted model training from a tagged dataset. This does not run destructive training commands.',
    parametersSchema: {
      type: 'object',
      properties: {
        datasetDir: { type: 'string' },
        outputName: { type: 'string' },
        baseModel: { type: 'string' },
        trainingType: { type: 'string', enum: ['lora', 'dreambooth', 'embedding'], description: 'Default lora.' },
        triggerWord: { type: 'string' },
        resolution: { type: 'number' },
        repeats: { type: 'number' },
        maxTrainSteps: { type: 'number' },
        trainerCommand: { type: 'string', description: 'Optional guarded command template to run training. Supports {datasetDir}, {outputName}, {baseModel}, {triggerWord}, {resolution}, {maxTrainSteps}, {manifestPath}.' },
        workingDir: { type: 'string', description: 'Optional command working directory.' },
      },
      required: ['datasetDir', 'outputName'],
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyListTrainingJobs',
    description: 'List reviewable targeted model training manifests prepared by comfyPrepareTrainingJob.',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text filter over outputName, datasetDir, baseModel, or status.' },
        status: { type: 'string', description: 'Optional status filter.' },
        limit: { type: 'number', description: 'Maximum jobs.' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyStartTrainingJob',
    description: 'Start a prepared LoRA/dreambooth/embedding training job from a manifest. Requires confirm:true and a trainerCommand in the manifest or params. Use dryRun:true to render the command without launching.',
    parametersSchema: {
      type: 'object',
      properties: {
        manifestPath: { type: 'string' },
        jobId: { type: 'string' },
        trainerCommand: { type: 'string', description: 'Command template override. Supports manifest placeholders.' },
        workingDir: { type: 'string' },
        confirm: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyGetTrainingJobStatus',
    description: 'Get a targeted model training job status, manifest, pid, exit code, and recent logs.',
    parametersSchema: {
      type: 'object',
      properties: {
        manifestPath: { type: 'string' },
        jobId: { type: 'string' },
        tail: { type: 'number' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyStopTrainingJob',
    description: 'Stop a running targeted model training process and persist the manifest as cancelled.',
    parametersSchema: {
      type: 'object',
      properties: {
        manifestPath: { type: 'string' },
        jobId: { type: 'string' },
      },
    },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyVersionStatus',
    description: 'Inspect local ComfyUI installation status: git branch/commit, Python path, server health, model inventory, custom nodes, and recommended maintenance actions.',
    parametersSchema: { type: 'object', properties: { comfyDir: { type: 'string' } } },
    category,
  });

  await anoclaw.tools.register({
    name: 'comfyManageVersion',
    description: 'Safely manage the local ComfyUI git installation. Supports status, fetch, planUpdate, pull, checkout, and listTags. Mutating actions require confirm:true and are refused while ComfyUI is running.',
    parametersSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'fetch', 'planUpdate', 'pull', 'checkout', 'listTags'] },
        comfyDir: { type: 'string', description: 'ComfyUI directory. Defaults to configured or auto-detected ComfyUI path.' },
        ref: { type: 'string', description: 'Branch/tag/commit for checkout.' },
        remote: { type: 'string', description: 'Git remote. Default origin.' },
        confirm: { type: 'boolean', description: 'Required for pull and checkout.' },
      },
      required: ['action'],
    },
    category,
  });
}

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
        negativePrompt: { type: 'string', description: 'Negative prompt for generation' },
        referenceImage: { type: 'string', description: 'Path to local image for img2img' },
        denoise: { type: 'number', description: 'Denoise strength 0.3-1.0' },
        steps: { type: 'number', description: 'Sampling steps (e.g. 20)' },
        seed: { type: 'number', description: 'Random seed, -1 for random' },
        width: { type: 'number', description: 'Image width (e.g. 1024)' },
        height: { type: 'number', description: 'Image height (e.g. 1024)' },
        outputDir: { type: 'string', description: 'Output directory' },
        extraParams: { type: 'object', description: 'Additional workflow schema parameters by name' },
      },
      required: ['action'],
    },
    category: 'Integration',
  });

  // ── Process management tools ──
  await registerComfyAutomationTools(anoclaw);

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
    { method: 'GET', path: '/api/v1/plugins/comfyui/asset-data', handler: 'assetDataRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/workflows', handler: 'listWorkflowsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/import', handler: 'importWorkflowRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/github/discover', handler: 'discoverGithubWorkflowsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/github/import', handler: 'importGithubWorkflowsRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/workflows/sources', handler: 'listWorkflowSourcesRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/community/discover', handler: 'discoverCommunityWorkflowsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/community/import', handler: 'importCommunityWorkflowsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/workflows/validate', handler: 'validateWorkflowRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/models', handler: 'listModelsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/models/download', handler: 'downloadModelRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/outputs', handler: 'listOutputsRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/jobs', handler: 'listJobsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/jobs/submit', handler: 'submitJobRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/jobs/status', handler: 'jobStatusRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/jobs/cancel', handler: 'cancelJobRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/prompt/enhance', handler: 'enhancePromptRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/tag-dataset', handler: 'tagDatasetRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/training/prepare', handler: 'prepareTrainingJobRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/training/jobs', handler: 'listTrainingJobsRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/training/start', handler: 'startTrainingJobRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/training/status', handler: 'trainingJobStatusRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/training/stop', handler: 'stopTrainingJobRoute' },
    { method: 'GET', path: '/api/v1/plugins/comfyui/version', handler: 'versionStatusRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/version/manage', handler: 'manageVersionRoute' },
    { method: 'POST', path: '/api/v1/plugins/comfyui/upload', handler: 'uploadImageProxy' },
  ]);

  // ── Prompt injection ──
  await anoclaw.prompt.inject('comfyui-usage',
    '## ComfyUI Image Generation Guidance\n' +
    '- Use Comfy for workflow inspect, generate, check, and download actions.\n' +
    '- Prefer comfyGenerateAsset for user-facing image/video generation jobs because it can enhance prompts and returns structured output paths.\n' +
    '- Use comfySubmitJob plus comfyGetJobStatus for video or long-running workflows so tool calls do not block on generation.\n' +
    '- Use comfyListWorkflows before generation when the workflow path is unknown. Use comfyImportWorkflow for raw/local workflow JSON files.\n' +
    '- Use comfyListWorkflowSources, comfyDiscoverCommunityWorkflows, and comfyImportCommunityWorkflows to discover diverse workflows from built-in community sources, GitHub, Gitee, raw JSON links, or pages that link workflow JSON.\n' +
    '- The legacy comfyDiscoverGithubWorkflows and comfyImportGithubWorkflows tools remain available for direct GitHub repository imports.\n' +
    '- Use comfyValidateWorkflow before running unfamiliar workflows; if it reports missing models or required inputs, fix those first.\n' +
    '- Use comfyListModels and comfyDownloadModel to inspect and install missing model files into guarded ComfyUI model folders. Model downloads require confirm:true unless dryRun:true.\n' +
    '- Use comfyTagDataset and comfyPrepareTrainingJob for LoRA/dataset preparation; they create reviewable local files and do not silently start long training runs.\n' +
    '- Use comfyListTrainingJobs, comfyStartTrainingJob, comfyGetTrainingJobStatus, and comfyStopTrainingJob to manage targeted model training. Starting training requires confirm:true and an explicit trainerCommand or prepared manifest command.\n' +
    '- Use comfyListJobs and comfyListOutputs to inspect prior automation work and generated assets before repeating a job.\n' +
    '- Use comfyManageVersion for ComfyUI maintenance; mutating version actions require confirm:true and should not be run while ComfyUI is active.\n' +
    '- Inspect a workflow before generation when parameters or model dependencies are unknown.\n' +
    '- Use startComfyUI, stopComfyUI, getComfyUIStatus, and getQueueStatus for process and queue management.\n' +
    '- For image-generation tasks, keep prompts explicit about subject, style, constraints, output directory, and required verification.\n' +
    '- The ComfyUI tab provides the visual prompt-to-image interface for user inspection.\n',
    45
  );

  await refreshComfyUISlot();

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
    await api.ui?.unmountAll('titlebar-right');
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
    case 'comfyGenerateAsset':
      return JSON.stringify(await handleGenerateAsset(params), null, 2);
    case 'comfySubmitJob':
      return JSON.stringify(await submitAsyncJob(params), null, 2);
    case 'comfyGetJobStatus':
      return JSON.stringify(await getAsyncJobStatus(params), null, 2);
    case 'comfyCancelJob':
      return JSON.stringify(await cancelAsyncJob(params), null, 2);
    case 'comfyEnhancePrompt':
      return JSON.stringify(await enhancePrompt(params), null, 2);
    case 'comfyListWorkflows':
      return JSON.stringify(await listWorkflowLibrary(params), null, 2);
    case 'comfyImportWorkflow':
      return await importWorkflow(params);
    case 'comfyDiscoverGithubWorkflows':
      return JSON.stringify(await discoverGithubWorkflows(params), null, 2);
    case 'comfyImportGithubWorkflows':
      return JSON.stringify(await importGithubWorkflows(params), null, 2);
    case 'comfyListWorkflowSources':
      return JSON.stringify(listWorkflowSources(params), null, 2);
    case 'comfyDiscoverCommunityWorkflows':
      return JSON.stringify(await discoverCommunityWorkflows(params), null, 2);
    case 'comfyImportCommunityWorkflows':
      return JSON.stringify(await importCommunityWorkflows(params), null, 2);
    case 'comfyValidateWorkflow':
      return JSON.stringify(await diagnoseWorkflow(params), null, 2);
    case 'comfyListOutputs':
      return JSON.stringify(await listOutputAssets(params), null, 2);
    case 'comfyListModels':
      return JSON.stringify(await listModels(params), null, 2);
    case 'comfyDownloadModel':
      return JSON.stringify(await downloadModel(params), null, 2);
    case 'comfyListJobs':
      return JSON.stringify(await listJobs(params), null, 2);
    case 'comfyTagDataset':
      return JSON.stringify(await tagDataset(params), null, 2);
    case 'comfyPrepareTrainingJob':
      return JSON.stringify(await prepareTrainingJob(params), null, 2);
    case 'comfyListTrainingJobs':
      return JSON.stringify(await listTrainingJobs(params), null, 2);
    case 'comfyStartTrainingJob':
      return JSON.stringify(await startTrainingJob(params), null, 2);
    case 'comfyGetTrainingJobStatus':
      return JSON.stringify(await getTrainingJobStatus(params), null, 2);
    case 'comfyStopTrainingJob':
      return JSON.stringify(await stopTrainingJob(params), null, 2);
    case 'comfyVersionStatus':
      return JSON.stringify(await getComfyVersionStatus(params), null, 2);
    case 'comfyManageVersion':
      return JSON.stringify(await manageComfyVersion(params), null, 2);
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

async function handleGenerateAsset(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const startedAt = new Date().toISOString();
  const jobId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!params.workflowPath) {
    const failure = { ok: false, jobId, status: 'failed', error: 'workflowPath is required', startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  const diagnostics = await diagnoseWorkflow(params);
  if (!diagnostics.ok) {
    const failure = { ok: false, jobId, status: 'failed', error: 'Workflow is not ready to run.', diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  let online = await comfy.healthCheck(5000);
  if (!online && params.autoStart) {
    const started = await startProcess({});
    addLog(`Auto-start requested by comfyGenerateAsset: ${started.slice(0, 300)}`);
    online = await comfy.waitForReady(120000);
  }
  if (!online) {
    const failure = { ok: false, jobId, status: 'failed', error: `ComfyUI is not reachable at ${serverUrl}`, diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  let prompt = params.prompt;
  let negativePrompt = params.negativePrompt;
  let promptPlan = null;
  if (!prompt && params.brief) {
    promptPlan = await enhancePrompt({
      brief: params.brief,
      kind: params.kind || 'image',
      style: params.style,
      constraints: params.constraints,
    });
    prompt = promptPlan.prompt;
    negativePrompt = negativePrompt || promptPlan.negativePrompt;
  }
  if (!prompt) {
    const failure = { ok: false, jobId, status: 'failed', error: 'prompt or brief is required', diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  const result = await comfy.generateImage({
    prompt,
    negativePrompt,
    workflowTemplate: params.workflowPath,
    referenceImage: params.referenceImage,
    denoise: params.denoise,
    steps: params.steps,
    seed: params.seed,
    width: params.width,
    height: params.height,
    outputDir: params.outputDir,
    extraParams: params.extraParams,
  });

  if (String(result).startsWith('Error:')) {
    const failure = { ok: false, jobId, status: 'failed', error: result, prompt, negativePrompt, promptPlan, diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  const outputs = String(result).split(',').map(s => s.trim()).filter(Boolean);
  const manifest = {
    ok: true,
    jobId,
    status: 'completed',
    kind: params.kind || 'image',
    workflowPath: path.resolve(params.workflowPath),
    prompt,
    negativePrompt,
    promptPlan,
    diagnostics,
    outputs,
    outputCount: outputs.length,
    params: sanitizeJobParams(params),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  await saveJobManifest(manifest);
  return manifest;
}

async function submitAsyncJob(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const startedAt = new Date().toISOString();
  const jobId = `async-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!params.workflowPath) {
    const failure = { ok: false, jobId, status: 'failed', error: 'workflowPath is required', startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  const diagnostics = await diagnoseWorkflow(params);
  if (!diagnostics.ok) {
    const failure = { ok: false, jobId, status: 'failed', error: 'Workflow is not ready to run.', diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  let online = await comfy.healthCheck(5000);
  if (!online && params.autoStart) {
    const started = await startProcess({});
    addLog(`Auto-start requested by comfySubmitJob: ${started.slice(0, 300)}`);
    online = await comfy.waitForReady(120000);
  }
  if (!online) {
    const failure = { ok: false, jobId, status: 'failed', error: `ComfyUI is not reachable at ${serverUrl}`, diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  let prompt = params.prompt;
  let negativePrompt = params.negativePrompt;
  let promptPlan = null;
  if (!prompt && params.brief) {
    promptPlan = await enhancePrompt({
      brief: params.brief,
      kind: params.kind || 'image',
      style: params.style,
      constraints: params.constraints,
    });
    prompt = promptPlan.prompt;
    negativePrompt = negativePrompt || promptPlan.negativePrompt;
  }
  if (!prompt) {
    const failure = { ok: false, jobId, status: 'failed', error: 'prompt or brief is required', diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }

  try {
    const prepared = await comfy.prepareWorkflow({
      prompt,
      negativePrompt,
      workflowTemplate: params.workflowPath,
      referenceImage: params.referenceImage,
      denoise: params.denoise,
      steps: params.steps,
      seed: params.seed,
      width: params.width,
      height: params.height,
      extraParams: params.extraParams,
    });
    const promptId = await comfy.submitWorkflow(prepared.workflow);
    const manifest = {
      ok: true,
      jobId,
      promptId,
      status: 'submitted',
      kind: params.kind || 'image',
      workflowPath: path.resolve(params.workflowPath),
      prompt,
      negativePrompt,
      promptPlan,
      diagnostics,
      outputs: [],
      outputCount: 0,
      params: sanitizeJobParams(params),
      prepared: { seed: prepared.seed, steps: prepared.steps, denoise: prepared.denoise, width: prepared.width, height: prepared.height },
      startedAt,
      submittedAt: new Date().toISOString(),
    };
    await saveJobManifest(manifest);
    return manifest;
  } catch (err) {
    const failure = { ok: false, jobId, status: 'failed', error: err.message, prompt, negativePrompt, promptPlan, diagnostics, params: sanitizeJobParams(params), startedAt, completedAt: new Date().toISOString() };
    await saveJobManifest(failure);
    return failure;
  }
}

async function getAsyncJobStatus(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  let job = null;
  if (params.jobId) job = await loadJobManifest(params.jobId);
  const promptId = params.promptId || job?.promptId;
  if (!promptId) return { ok: false, error: 'jobId or promptId is required' };

  const online = await comfy.healthCheck(5000);
  if (!online) return { ok: false, jobId: job?.jobId || params.jobId || null, promptId, status: job?.status || 'unknown', error: `ComfyUI is not reachable at ${serverUrl}`, job };

  const status = await comfy.getPromptStatus(promptId, params.outputDir || job?.params?.outputDir || getDefaultOutputDir());
  if (job) {
    job.status = status.status;
    job.outputs = status.outputs || job.outputs || [];
    job.outputCount = job.outputs.length;
    job.lastCheckedAt = new Date().toISOString();
    if (status.status === 'completed') job.completedAt = job.completedAt || new Date().toISOString();
    await saveJobManifest(job);
  }
  return { ok: true, jobId: job?.jobId || null, ...status, job };
}

async function cancelAsyncJob(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  let job = null;
  if (params.jobId) job = await loadJobManifest(params.jobId);
  const promptId = params.promptId || job?.promptId;
  if (!promptId) return { ok: false, error: 'jobId or promptId is required' };

  await comfy.cancel(promptId);
  if (job) {
    job.status = 'cancelled';
    job.cancelledAt = new Date().toISOString();
    await saveJobManifest(job);
  }
  return { ok: true, jobId: job?.jobId || null, promptId, status: 'cancelled' };
}

async function enhancePrompt(params = {}) {
  const brief = String(params.brief || '').trim();
  if (!brief) return { prompt: '', negativePrompt: '', notes: ['brief is empty'] };

  const kind = params.kind || 'image';
  const system = [
    'You write production prompts for ComfyUI image and video workflows.',
    'Return strict JSON with keys: prompt, negativePrompt, tags, notes.',
    'The prompt must be concrete, visual, composition-aware, and avoid unverifiable hype.',
    'For video, include motion, camera movement, temporal consistency, and scene continuity.',
  ].join(' ');
  const user = [
    `Kind: ${kind}`,
    params.style ? `Style: ${params.style}` : '',
    params.constraints ? `Constraints: ${params.constraints}` : '',
    `Brief: ${brief}`,
  ].filter(Boolean).join('\n');

  try {
    const resp = await api?.llm?.chat?.([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.35, maxTokens: 800 });
    const parsed = extractJsonObject(resp?.content || '');
    if (parsed?.prompt) {
      return {
        prompt: String(parsed.prompt),
        negativePrompt: String(parsed.negativePrompt || defaultNegativePrompt(kind)),
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        source: 'llm',
      };
    }
  } catch (err) {
    addLog(`Prompt enhancement fallback: ${err.message}`);
  }

  const prompt = [
    brief,
    params.style,
    kind === 'video' ? 'smooth motion, stable identity, consistent lighting, coherent frame-to-frame detail' : 'sharp focus, balanced composition, detailed subject, controlled lighting',
    params.constraints,
  ].filter(Boolean).join(', ');
  return {
    prompt,
    negativePrompt: defaultNegativePrompt(kind),
    tags: deriveTagsFromText(`${brief} ${params.style || ''}`),
    notes: ['LLM prompt enhancement unavailable; used deterministic prompt expansion.'],
    source: 'fallback',
  };
}

function defaultNegativePrompt(kind) {
  const common = 'low quality, blurry, distorted anatomy, bad hands, malformed face, extra limbs, text artifacts, watermark, logo, jpeg artifacts';
  return kind === 'video'
    ? `${common}, flicker, unstable identity, inconsistent motion, warped frames`
    : common;
}

function extractJsonObject(text) {
  try { return JSON.parse(text); } catch {}
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function importWorkflow(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const dest = params.workflowPath || path.join(getPluginDir(), 'workflows', `${safeFileBase(params.name || 'workflow')}.json`);
  if (params.url) return await handleDownload({ url: params.url, workflowPath: dest });
  if (!params.sourcePath) return 'Error: url or sourcePath is required.';

  let parsed;
  try { parsed = JSON.parse(await fs.readFile(params.sourcePath, 'utf-8')); }
  catch (err) { return `Error: cannot read source workflow: ${err.message}`; }

  const normalized = normalizeWorkflowObject(parsed);
  if (!normalized.workflow) return normalized.error;
  await fs.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
  await fs.writeFile(path.resolve(dest), JSON.stringify(normalized.workflow, null, 2), 'utf-8');
  const schema = comfy.extractSchema(normalized.workflow);
  return `Imported -> ${path.resolve(dest)}\nFormat: ${normalized.format}. Nodes: ${normalized.nodeCount}. Params: ${Object.keys(schema.parameters).join(', ') || '(none)'}`;
}

async function discoverGithubWorkflows(params = {}) {
  if (!params.url) return { ok: false, error: 'url is required' };
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const parsed = parseGithubUrl(params.url, params);
  if (!parsed.ok) return parsed;

  const limit = clampNumber(params.limit, 1, 200, 50);
  const recursive = params.recursive !== false;
  let files;
  try {
    files = await listGithubJsonFiles(parsed, { recursive, limit });
  } catch (err) {
    return { ok: false, error: `GitHub discovery failed: ${err.message}`, source: parsed };
  }
  const workflows = [];

  for (const file of files.slice(0, limit)) {
    try {
      const text = await fetchText(file.downloadUrl, 20000);
      const parsedJson = JSON.parse(text.trim());
      const normalized = normalizeWorkflowObject(parsedJson);
      if (!normalized.workflow) {
        workflows.push({ ...file, ok: false, error: normalized.error });
        continue;
      }
      const schema = comfy.extractSchema(normalized.workflow);
      const modelStatus = await checkModelDependencies(schema.modelDependencies);
      const nodeClassStatus = await checkNodeClassDependencies(normalized.workflow);
      workflows.push({
        ...file,
        ok: true,
        format: normalized.format,
        nodes: normalized.nodeCount,
        params: Object.keys(schema.parameters),
        summary: schema.summary,
        modelDependencies: modelStatus,
        nodeClassDependencies: nodeClassStatus,
        missingModels: modelStatus.filter(m => m.folder !== 'input' && !m.exists),
        missingNodeClasses: nodeClassStatus.missing,
      });
    } catch (err) {
      workflows.push({ ...file, ok: false, error: err.message });
    }
  }

  return {
    ok: true,
    source: parsed,
    totalCandidates: files.length,
    workflowCount: workflows.filter(w => w.ok).length,
    workflows,
  };
}

function listWorkflowSources(params = {}) {
  const query = String(params.query || '').trim().toLowerCase();
  const sources = COMMUNITY_WORKFLOW_SOURCES.map(source => ({ ...source }));
  if (!query) return { ok: true, sourceCount: sources.length, sources };
  const filtered = sources.filter(source => [
    source.id,
    source.title,
    source.provider,
    source.region,
    ...(source.tags || []),
  ].some(value => String(value || '').toLowerCase().includes(query)));
  return { ok: true, sourceCount: filtered.length, sources: filtered };
}

function communitySourceInputs(params = {}) {
  const inputs = [];
  const add = (item) => {
    if (!item) return;
    const url = String(item.url || item).trim();
    if (!url) return;
    inputs.push({
      id: item.id || safeFileBase(url),
      title: item.title || url,
      provider: item.provider || 'auto',
      region: item.region || 'custom',
      url,
      tags: item.tags || [],
    });
  };

  if (params.sourceId) {
    const source = COMMUNITY_WORKFLOW_SOURCES.find(s => s.id === params.sourceId);
    if (!source) return { ok: false, error: `Unknown workflow sourceId: ${params.sourceId}` };
    add(source);
  }
  add(params.url);
  for (const url of Array.isArray(params.urls) ? params.urls : []) add(url);
  if (inputs.length === 0) return { ok: false, error: 'sourceId, url, or urls is required' };
  return { ok: true, inputs };
}

async function discoverCommunityWorkflows(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const inputResult = communitySourceInputs(params);
  if (!inputResult.ok) return inputResult;
  const limit = clampNumber(params.limit, 1, 200, 50);
  const query = String(params.query || '').trim().toLowerCase();
  const sources = [];
  const allWorkflows = [];

  for (const input of inputResult.inputs) {
    const perSourceParams = { ...params, url: input.url, limit, sourceMeta: input };
    const result = await discoverSingleCommunitySource(perSourceParams);
    if (query && Array.isArray(result.workflows)) {
      result.workflows = result.workflows.filter(item => [
        item.name,
        item.relativePath,
        item.htmlUrl,
        item.downloadUrl,
        item.format,
        ...(item.params || []),
      ].some(value => String(value || '').toLowerCase().includes(query)));
      result.workflowCount = result.workflows.filter(w => w.ok).length;
      result.totalCandidates = result.workflows.length;
    }
    sources.push(result);
    for (const item of result.workflows || []) allWorkflows.push({ ...item, sourceId: input.id, sourceTitle: input.title });
  }

  return {
    ok: sources.every(source => source.ok !== false),
    sourceCount: sources.length,
    totalCandidates: allWorkflows.length,
    workflowCount: allWorkflows.filter(w => w.ok).length,
    sources,
    workflows: allWorkflows,
  };
}

async function discoverSingleCommunitySource(params = {}) {
  const sourceMeta = params.sourceMeta || { id: 'custom', title: params.url, provider: 'auto', url: params.url, tags: [] };
  const url = String(params.url || '').trim();
  if (!url) return { ok: false, source: sourceMeta, error: 'url is required', workflows: [] };
  const provider = detectWorkflowSourceProvider(url);

  if (provider === 'github') {
    const result = await discoverGithubWorkflows(params);
    return { ...result, source: { ...sourceMeta, ...(result.source || {}), provider: 'github' } };
  }
  if (provider === 'gitee') {
    return await discoverGiteeWorkflows(params, sourceMeta);
  }
  return await discoverWebOrRawWorkflows(params, sourceMeta, provider);
}

function detectWorkflowSourceProvider(url) {
  let u;
  try { u = new URL(url); } catch { return 'unknown'; }
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'raw.githubusercontent.com') return 'github';
  if (host === 'gitee.com' || host.endsWith('.gitee.com')) return 'gitee';
  if (/\.json($|[?#])/i.test(u.pathname)) return 'raw-json';
  return 'webpage';
}

async function inspectWorkflowCandidate(file) {
  try {
    const text = await fetchText(file.downloadUrl, 20000);
    const parsedJson = JSON.parse(text.trim());
    const normalized = normalizeWorkflowObject(parsedJson);
    if (!normalized.workflow) return { ...file, ok: false, error: normalized.error };
    const schema = comfy.extractSchema(normalized.workflow);
    const modelStatus = await checkModelDependencies(schema.modelDependencies);
    const nodeClassStatus = await checkNodeClassDependencies(normalized.workflow);
    return {
      ...file,
      ok: true,
      format: normalized.format,
      nodes: normalized.nodeCount,
      params: Object.keys(schema.parameters),
      summary: schema.summary,
      modelDependencies: modelStatus,
      nodeClassDependencies: nodeClassStatus,
      missingModels: modelStatus.filter(m => m.folder !== 'input' && !m.exists),
      missingNodeClasses: nodeClassStatus.missing,
    };
  } catch (err) {
    return { ...file, ok: false, error: err.message };
  }
}

async function discoverGiteeWorkflows(params = {}, sourceMeta = {}) {
  const parsed = parseGiteeUrl(params.url, params);
  if (!parsed.ok) return { ok: false, source: { ...sourceMeta, provider: 'gitee' }, error: parsed.error, workflows: [] };
  const limit = clampNumber(params.limit, 1, 200, 50);
  let files;
  try {
    files = await listGiteeJsonFiles(parsed, { recursive: params.recursive !== false, limit });
  } catch (err) {
    return { ok: false, source: { ...sourceMeta, ...parsed, provider: 'gitee' }, error: `Gitee discovery failed: ${err.message}`, workflows: [] };
  }
  const workflows = [];
  for (const file of files.slice(0, limit)) workflows.push(await inspectWorkflowCandidate({ ...file, provider: 'gitee' }));
  return {
    ok: true,
    source: { ...sourceMeta, ...parsed, provider: 'gitee' },
    totalCandidates: files.length,
    workflowCount: workflows.filter(w => w.ok).length,
    workflows,
  };
}

async function discoverWebOrRawWorkflows(params = {}, sourceMeta = {}, provider = 'webpage') {
  const limit = clampNumber(params.limit, 1, 200, 50);
  let candidates = [];
  try {
    if (provider === 'raw-json') {
      const u = new URL(params.url);
      candidates = [{
        name: path.posix.basename(u.pathname) || `${safeFileBase(sourceMeta.id || 'workflow')}.json`,
        relativePath: path.posix.basename(u.pathname) || 'workflow.json',
        downloadUrl: params.url,
        htmlUrl: params.url,
        provider,
      }];
    } else {
      candidates = await extractJsonLinksFromPage(params.url, limit);
    }
  } catch (err) {
    return { ok: false, source: { ...sourceMeta, provider }, error: `Community page discovery failed: ${err.message}`, workflows: [] };
  }
  const workflows = [];
  for (const file of candidates.slice(0, limit)) workflows.push(await inspectWorkflowCandidate(file));
  return {
    ok: true,
    source: { ...sourceMeta, provider },
    totalCandidates: candidates.length,
    workflowCount: workflows.filter(w => w.ok).length,
    workflows,
  };
}

async function extractJsonLinksFromPage(url, limit) {
  const text = await fetchText(url, 20000, { 'User-Agent': 'AnoClaw-ComfyUI-Plugin' });
  const links = new Set();
  const patterns = [
    /href\s*=\s*["']([^"']+\.json(?:[?#][^"']*)?)["']/ig,
    /https?:\/\/[^\s"'<>]+\.json(?:[?#][^\s"'<>]+)?/ig,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) && links.size < limit) {
      const raw = match[1] || match[0];
      try { links.add(new URL(raw.replace(/&amp;/g, '&'), url).toString()); } catch {}
    }
  }
  return Array.from(links).map(link => {
    const u = new URL(link);
    return {
      name: path.posix.basename(u.pathname) || 'workflow.json',
      relativePath: decodeURIComponent(path.posix.basename(u.pathname) || 'workflow.json'),
      downloadUrl: link,
      htmlUrl: link,
      provider: 'webpage',
    };
  });
}

async function importGithubWorkflows(params = {}) {
  const discovered = await discoverGithubWorkflows(params);
  if (!discovered.ok) return discovered;

  const destinationDir = params.destinationDir || path.join(getPluginDir(), 'workflows', 'github', safeFileBase(`${discovered.source.owner}-${discovered.source.repo}`));
  await fs.mkdir(destinationDir, { recursive: true });
  const imported = [];
  const skipped = [];

  for (const item of discovered.workflows.filter(w => w.ok)) {
    const fileName = safeFileBase(item.relativePath.replace(/\.json$/i, '')) + '.json';
    const dest = path.join(destinationDir, fileName);
    if (!params.overwrite) {
      try {
        await fs.access(dest);
        skipped.push({ source: item.downloadUrl, path: dest, reason: 'exists' });
        continue;
      } catch {}
    }
    try {
      const text = await fetchText(item.downloadUrl, 20000);
      const normalized = normalizeWorkflowObject(JSON.parse(text.trim()));
      if (!normalized.workflow) {
        skipped.push({ source: item.downloadUrl, path: dest, reason: normalized.error });
        continue;
      }
      await fs.writeFile(dest, JSON.stringify(normalized.workflow, null, 2), 'utf-8');
      imported.push({ source: item.downloadUrl, path: dest, nodes: normalized.nodeCount, summary: item.summary });
    } catch (err) {
      skipped.push({ source: item.downloadUrl, path: dest, reason: err.message });
    }
  }

  return {
    ok: true,
    source: discovered.source,
    destinationDir,
    importedCount: imported.length,
    skippedCount: skipped.length,
    imported,
    skipped,
  };
}

async function importCommunityWorkflows(params = {}) {
  const discovered = await discoverCommunityWorkflows(params);
  if (!discovered.ok && !discovered.workflows?.some(w => w.ok)) return discovered;
  const imported = [];
  const skipped = [];

  for (const source of discovered.sources || []) {
    const sourceId = safeFileBase(source.source?.id || source.source?.repo || source.source?.title || 'community');
    const destinationDir = params.destinationDir || path.join(getPluginDir(), 'workflows', 'community', sourceId);
    await fs.mkdir(destinationDir, { recursive: true });
    for (const item of (source.workflows || []).filter(w => w.ok)) {
      const base = item.relativePath || item.name || item.downloadUrl || 'workflow.json';
      const fileName = safeFileBase(String(base).replace(/\.json$/i, '')) + '.json';
      const dest = path.join(destinationDir, fileName);
      if (!params.overwrite) {
        try {
          await fs.access(dest);
          skipped.push({ source: item.downloadUrl, path: dest, reason: 'exists' });
          continue;
        } catch {}
      }
      try {
        const text = await fetchText(item.downloadUrl, 20000);
        const normalized = normalizeWorkflowObject(JSON.parse(text.trim()));
        if (!normalized.workflow) {
          skipped.push({ source: item.downloadUrl, path: dest, reason: normalized.error });
          continue;
        }
        await fs.writeFile(dest, JSON.stringify(normalized.workflow, null, 2), 'utf-8');
        imported.push({ source: item.downloadUrl, path: dest, nodes: normalized.nodeCount, summary: item.summary, sourceId });
      } catch (err) {
        skipped.push({ source: item.downloadUrl, path: dest, reason: err.message });
      }
    }
  }

  return {
    ok: true,
    sourceCount: discovered.sourceCount,
    workflowCount: discovered.workflowCount,
    importedCount: imported.length,
    skippedCount: skipped.length,
    imported,
    skipped,
    sources: discovered.sources?.map(source => source.source) || [],
  };
}

async function diagnoseWorkflow(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  if (!params.workflowPath) return { ok: false, error: 'workflowPath is required' };

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(params.workflowPath, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `Cannot read workflow: ${err.message}`, workflowPath: params.workflowPath };
  }

  const normalized = normalizeWorkflowObject(parsed);
  if (!normalized.workflow) return { ok: false, error: normalized.error, workflowPath: params.workflowPath };
  const workflow = normalized.workflow;
  const schema = comfy.extractSchema(workflow);
  const modelStatus = await checkModelDependencies(schema.modelDependencies);
  const nodeClassStatus = await checkNodeClassDependencies(workflow);
  const inputStatus = await checkWorkflowInputs(workflow, params.referenceImage);
  const overrideStatus = checkParameterOverrides(schema, params.extraParams || {});
  const issues = [
    ...modelStatus.filter(m => m.folder !== 'input' && !m.exists).map(m => `Missing ${m.folder}: ${m.value}`),
    ...(nodeClassStatus.checked ? nodeClassStatus.missing.map(item => `Missing node class: ${item.classType}`) : []),
    ...inputStatus.filter(i => !i.satisfied).map(i => `Input image required for node ${i.nodeId}: ${i.value}`),
    ...overrideStatus.filter(o => !o.exists).map(o => `Unknown workflow parameter: ${o.name}`),
  ];

  return {
    ok: issues.length === 0,
    workflowPath: path.resolve(params.workflowPath),
    format: normalized.format,
    nodeCount: normalized.nodeCount,
    summary: schema.summary,
    parameters: schema.parameters,
    outputNodes: schema.outputNodes,
    modelDependencies: modelStatus,
    nodeClassDependencies: nodeClassStatus,
    inputImages: inputStatus,
    parameterOverrides: overrideStatus,
    issues,
  };
}

async function listWorkflowLibrary(params = {}) {
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  const dirs = params.dir ? [params.dir] : getDefaultWorkflowDirs();
  const files = [];
  for (const dir of dirs) files.push(...await scanFiles(dir, new Set(['.json'])));
  const query = String(params.query || '').toLowerCase();
  const limit = clampNumber(params.limit, 1, 200, 50);
  const workflows = [];
  for (const file of files) {
    if (query && !file.toLowerCase().includes(query)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      const normalized = normalizeWorkflowObject(parsed);
      if (!normalized.workflow) continue;
      const schema = comfy.extractSchema(normalized.workflow);
      const modelStatus = await checkModelDependencies(schema.modelDependencies);
      const nodeClassStatus = await checkNodeClassDependencies(normalized.workflow);
      workflows.push({
        path: file,
        name: path.basename(file),
        format: normalized.format,
        nodes: normalized.nodeCount,
        params: Object.keys(schema.parameters),
        modelDependencies: modelStatus,
        nodeClassDependencies: nodeClassStatus,
        missingModels: modelStatus.filter(m => m.folder !== 'input' && !m.exists),
        missingNodeClasses: nodeClassStatus.missing,
        summary: schema.summary,
      });
    } catch {}
    if (workflows.length >= limit) break;
  }
  return { workflowCount: workflows.length, scanDirs: dirs, workflows };
}

async function listOutputAssets(params = {}) {
  const dir = params.dir || getDefaultOutputDir();
  const query = String(params.query || '').toLowerCase();
  const limit = clampNumber(params.limit, 1, 500, 80);
  const jobsByOutput = await indexJobsByOutput();
  const files = await scanFiles(dir, SUPPORTED_ASSET_EXTENSIONS);
  const assets = [];
  for (const file of files) {
    if (query && !file.toLowerCase().includes(query)) continue;
    try {
      const stat = await fs.stat(file);
      const captionPath = file.replace(/\.[^.]+$/, '.txt');
      let caption = null;
      try { caption = await fs.readFile(captionPath, 'utf-8'); } catch {}
      assets.push({
        path: file,
        filename: path.basename(file),
        extension: path.extname(file).toLowerCase(),
        kind: assetKind(file),
        size: stat.size,
        mtime: stat.mtimeMs,
        job: jobsByOutput.get(path.resolve(file).toLowerCase()) || null,
        captionPath: caption ? captionPath : null,
        captionPreview: caption ? caption.slice(0, 240) : null,
      });
    } catch {}
  }
  assets.sort((a, b) => b.mtime - a.mtime);
  return { dir, total: assets.length, assets: assets.slice(0, limit) };
}

async function listModels(params = {}) {
  const inventory = await collectModelInventory(path.join(getComfyDir(), 'models'));
  const query = String(params.query || '').toLowerCase();
  const folder = String(params.folder || '').toLowerCase();
  const limit = clampNumber(params.limit, 1, 10000, 500);
  const models = [];
  for (const [group, files] of Object.entries(inventory || {})) {
    if (folder && group.toLowerCase() !== folder) continue;
    for (const item of files || []) {
      const haystack = JSON.stringify(item).toLowerCase();
      if (query && !haystack.includes(query)) continue;
      models.push({ folder: group, ...item });
    }
  }
  models.sort((a, b) => String(a.folder).localeCompare(String(b.folder)) || String(a.name).localeCompare(String(b.name)));
  return { comfyDir: getComfyDir(), total: models.length, models: models.slice(0, limit), folders: Object.keys(inventory || {}).sort() };
}

async function downloadModel(params = {}) {
  if (!params.url) return { ok: false, error: 'url is required' };
  const folder = String(params.folder || '').trim();
  const targetDir = modelTargetDir(folder);
  if (!targetDir) return { ok: false, error: `Unsupported model folder: ${folder}` };
  const filename = safeModelFilename(params.filename || filenameFromUrl(params.url));
  if (!filename) return { ok: false, error: 'filename could not be inferred; provide filename.' };
  const dest = path.resolve(targetDir, filename);
  if (!isPathInside(dest, targetDir)) return { ok: false, error: 'Resolved model path escaped target directory.' };
  const record = {
    id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: params.url,
    folder,
    filename,
    path: dest,
    createdAt: new Date().toISOString(),
  };
  if (params.dryRun) return { ok: true, dryRun: true, targetDir, path: dest, record };
  if (!params.confirm) return { ok: false, error: 'model download requires confirm:true', targetDir, path: dest };

  try {
    await fs.mkdir(targetDir, { recursive: true });
    try {
      await fs.access(dest);
      if (!params.overwrite) return { ok: false, error: 'target file already exists', path: dest };
    } catch {}
    const result = await downloadUrlToFile(params.url, dest, params.headers || {});
    const manifest = { ...record, ...result, status: 'completed', completedAt: new Date().toISOString() };
    await saveModelDownloadManifest(manifest);
    return { ok: true, ...manifest };
  } catch (err) {
    const manifest = { ...record, status: 'failed', error: err.message, completedAt: new Date().toISOString() };
    await saveModelDownloadManifest(manifest).catch(() => {});
    return { ok: false, ...manifest };
  }
}

function modelTargetDir(folder) {
  const allowed = new Set(['checkpoints', 'unet', 'diffusion_models', 'vae', 'clip', 'loras', 'lora', 'controlnet', 'control_net', 'upscale_models']);
  const key = String(folder || '').replace(/\\/g, '/').replace(/^models\//i, '').toLowerCase();
  if (!allowed.has(key)) return null;
  const normalized = key === 'lora' ? 'loras' : key === 'control_net' ? 'controlnet' : key;
  return path.resolve(getComfyDir(), 'models', normalized);
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(path.posix.basename(parsed.pathname || ''));
    return name && name !== '/' ? name : '';
  } catch {
    return '';
  }
}

function safeModelFilename(value) {
  const name = path.basename(String(value || '').replace(/\\/g, '/'));
  if (!/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(name)) return '';
  return name.replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
}

async function downloadUrlToFile(url, dest, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('download response has no body');
  const tmpPath = `${dest}.${process.pid}.${Date.now()}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
    const stat = await fs.stat(tmpPath);
    await fs.rename(tmpPath, dest);
    return {
      path: dest,
      size: stat.size,
      contentType: response.headers.get('content-type') || null,
      sourceUrl: response.url || url,
    };
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function saveModelDownloadManifest(manifest) {
  await fs.mkdir(MODEL_DOWNLOAD_DIR, { recursive: true });
  const file = path.join(MODEL_DOWNLOAD_DIR, `${safeFileBase(manifest.id)}.json`);
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ ...manifest, manifestPath: file }, null, 2), 'utf-8');
  await fs.rename(tmpPath, file);
  return file;
}

function assetKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'file';
}

async function saveJobManifest(job) {
  const dir = JOB_HISTORY_DIR;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFileBase(job.jobId || `job-${Date.now()}`)}.json`);
  const payload = { ...job, manifestPath: file };
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tmpPath, file);
  return file;
}

async function loadJobManifest(jobId) {
  if (!jobId) return null;
  const file = path.join(JOB_HISTORY_DIR, `${safeFileBase(jobId)}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function listJobs(params = {}) {
  const dir = JOB_HISTORY_DIR;
  const limit = clampNumber(params.limit, 1, 500, 80);
  const status = String(params.status || '').toLowerCase();
  const query = String(params.query || '').toLowerCase();
  const files = await scanFiles(dir, new Set(['.json']), 2);
  const jobs = [];
  for (const file of files) {
    try {
      const job = JSON.parse(await fs.readFile(file, 'utf-8'));
      const haystack = JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        prompt: job.prompt,
        workflowPath: job.workflowPath,
        outputs: job.outputs,
        error: job.error,
      }).toLowerCase();
      if (status && String(job.status || '').toLowerCase() !== status) continue;
      if (query && !haystack.includes(query)) continue;
      jobs.push({ ...job, manifestPath: file });
    } catch {}
  }
  jobs.sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || '')));
  return { total: jobs.length, jobs: jobs.slice(0, limit) };
}

async function indexJobsByOutput() {
  const result = new Map();
  const listed = await listJobs({ limit: 500 });
  for (const job of listed.jobs || []) {
    for (const output of job.outputs || []) {
      result.set(path.resolve(output).toLowerCase(), {
        jobId: job.jobId,
        status: job.status,
        prompt: job.prompt,
        workflowPath: job.workflowPath,
        manifestPath: job.manifestPath,
        completedAt: job.completedAt,
      });
    }
  }
  return result;
}

function sanitizeJobParams(params = {}) {
  const out = { ...params };
  delete out.apiKey;
  delete out.token;
  return out;
}

async function readComfyPngMetadata(file) {
  if (path.extname(file).toLowerCase() !== '.png') return {};
  let buf;
  try { buf = await fs.readFile(file); } catch { return {}; }
  if (buf.length < 12 || buf.toString('ascii', 1, 4) !== 'PNG') return {};

  const textChunks = {};
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = data.subarray(0, nul).toString('latin1');
        const value = data.subarray(nul + 1).toString('utf-8');
        textChunks[key] = value;
      }
    } else if (type === 'iTXt') {
      const parsed = parseITxtChunk(data);
      if (parsed?.key) textChunks[parsed.key] = parsed.value;
    }
    offset = dataEnd + 4;
  }

  const promptText = extractPromptTextFromMetadata(textChunks);
  return { ...textChunks, promptText, positivePrompt: promptText };
}

function parseITxtChunk(data) {
  try {
    const nul = data.indexOf(0);
    if (nul <= 0) return null;
    const key = data.subarray(0, nul).toString('utf-8');
    let cursor = nul + 1;
    const compressionFlag = data[cursor++];
    cursor++; // compression method
    const langEnd = data.indexOf(0, cursor);
    if (langEnd < 0) return null;
    cursor = langEnd + 1;
    const translatedEnd = data.indexOf(0, cursor);
    if (translatedEnd < 0) return null;
    cursor = translatedEnd + 1;
    if (compressionFlag !== 0) return { key, value: '' };
    return { key, value: data.subarray(cursor).toString('utf-8') };
  } catch {
    return null;
  }
}

function extractPromptTextFromMetadata(metadata) {
  const direct = metadata.prompt || metadata.Prompt || metadata.description || metadata.parameters;
  if (direct && typeof direct === 'string') {
    const parsed = extractJsonObject(direct);
    if (parsed) {
      const text = findTextInComfyPromptObject(parsed);
      if (text) return text;
    }
    return direct.slice(0, 1000);
  }
  return '';
}

function findTextInComfyPromptObject(obj) {
  const texts = [];
  const prompt = obj?.prompt && typeof obj.prompt === 'object' ? obj.prompt : obj;
  for (const node of Object.values(prompt || {})) {
    if (!node || typeof node !== 'object') continue;
    const cls = node.class_type || '';
    const inputs = node.inputs || {};
    if (cls.includes('TextEncode')) {
      for (const field of PROMPT_FIELDS) {
        const value = inputs[field];
        if (typeof value === 'string' && value.trim()) texts.push(value.trim());
      }
      if (typeof inputs.text === 'string' && inputs.text.trim()) texts.push(inputs.text.trim());
    }
  }
  return normalizeTags(texts).join(', ');
}

function buildSentenceCaption({ triggerWord, promptTexts, tags }) {
  const lead = normalizeTags([triggerWord, ...promptTexts]).filter(Boolean).join(', ');
  if (lead) return lead;
  return tags.join(', ');
}

async function tagDataset(params = {}) {
  if (!params.datasetDir) return { ok: false, error: 'datasetDir is required' };
  const images = await scanFiles(params.datasetDir, SUPPORTED_IMAGE_EXTENSIONS);
  const limit = clampNumber(params.limit, 1, 10000, images.length || 1);
  const baseTags = normalizeTags(params.baseTags || []);
  const triggerWord = String(params.triggerWord || '').trim();
  const useJobPrompts = params.useJobPrompts !== false;
  const useComfyMetadata = params.useComfyMetadata !== false;
  const includeFileTags = params.includeFileTags !== false;
  const captionStyle = params.captionStyle || 'tags';
  const jobsByOutput = useJobPrompts ? await indexJobsByOutput() : new Map();
  const written = [];
  const skipped = [];

  for (const file of images.slice(0, limit)) {
    const captionPath = file.replace(/\.[^.]+$/, '.txt');
    if (!params.overwrite) {
      try {
        await fs.access(captionPath);
        skipped.push({ image: file, captionPath, reason: 'exists' });
        continue;
      } catch {}
    }
    const metadata = useComfyMetadata ? await readComfyPngMetadata(file) : {};
    const job = jobsByOutput.get(path.resolve(file).toLowerCase()) || null;
    const promptTexts = normalizeTags([
      job?.prompt,
      metadata.positivePrompt,
      metadata.promptText,
    ]);
    const tags = normalizeTags([
      triggerWord,
      ...baseTags,
      ...promptTexts.flatMap(text => deriveTagsFromText(text)),
      ...(includeFileTags ? deriveTagsFromText(path.basename(file, path.extname(file))) : []),
      ...(includeFileTags ? deriveTagsFromText(path.basename(path.dirname(file))) : []),
    ]);
    const caption = captionStyle === 'sentence'
      ? buildSentenceCaption({ triggerWord, promptTexts, tags })
      : tags.join(', ');
    await fs.writeFile(captionPath, caption, 'utf-8');
    written.push({
      image: file,
      captionPath,
      caption,
      sources: {
        jobId: job?.jobId || null,
        hasComfyMetadata: Object.keys(metadata).length > 0,
        promptTextCount: promptTexts.length,
      },
    });
  }

  return { ok: true, datasetDir: path.resolve(params.datasetDir), imageCount: images.length, writtenCount: written.length, skippedCount: skipped.length, written, skipped };
}

async function prepareTrainingJob(params = {}) {
  if (!params.datasetDir) return { ok: false, error: 'datasetDir is required' };
  if (!params.outputName) return { ok: false, error: 'outputName is required' };
  const datasetDir = path.resolve(params.datasetDir);
  const images = await scanFiles(datasetDir, SUPPORTED_IMAGE_EXTENSIONS);
  const captions = await scanFiles(datasetDir, new Set(['.txt']));
  const trainingType = params.trainingType || 'lora';
  const job = {
    id: `${safeFileBase(params.outputName)}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    trainingType,
    outputName: params.outputName,
    datasetDir,
    imageCount: images.length,
    captionCount: captions.length,
    baseModel: params.baseModel || null,
    triggerWord: params.triggerWord || null,
    resolution: params.resolution || 1024,
    repeats: params.repeats || 10,
    maxTrainSteps: params.maxTrainSteps || 1200,
    trainerCommand: params.trainerCommand || null,
    workingDir: params.workingDir || null,
    status: 'planned',
    warnings: [],
    commandPlan: [
      'Review captions and remove weak or duplicated tags.',
      'Use a dedicated trainer such as kohya_ss or ai-toolkit with this manifest.',
      'Copy the resulting LoRA into the configured ComfyUI models/loras directory and refresh ComfyUI.',
    ],
  };
  if (images.length === 0) job.warnings.push('No training images found.');
  if (captions.length < images.length) job.warnings.push('Some images do not have .txt caption sidecars.');
  if (!job.baseModel) job.warnings.push('baseModel was not provided; choose the exact Flux/SD checkpoint before training.');

  if (!job.trainerCommand) job.warnings.push('trainerCommand was not provided; this manifest can be reviewed but cannot be launched until a trainer command is added or supplied at start time.');

  const outDir = TRAINING_JOB_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, `${job.id}.json`);
  job.manifestPath = manifestPath;
  await fs.writeFile(manifestPath, JSON.stringify(job, null, 2), 'utf-8');
  return { ok: true, manifestPath, job };
}

async function listTrainingJobs(params = {}) {
  const limit = clampNumber(params.limit, 1, 500, 80);
  const status = String(params.status || '').toLowerCase();
  const query = String(params.query || '').toLowerCase();
  const files = await scanFiles(TRAINING_JOB_DIR, new Set(['.json']), 2);
  const jobs = [];
  for (const file of files) {
    try {
      const job = JSON.parse(await fs.readFile(file, 'utf-8'));
      const manifest = { ...job, manifestPath: job.manifestPath || file };
      const haystack = JSON.stringify({
        id: manifest.id,
        status: manifest.status,
        outputName: manifest.outputName,
        datasetDir: manifest.datasetDir,
        baseModel: manifest.baseModel,
        trainingType: manifest.trainingType,
      }).toLowerCase();
      if (status && String(manifest.status || '').toLowerCase() !== status) continue;
      if (query && !haystack.includes(query)) continue;
      jobs.push(manifest);
    } catch {}
  }
  jobs.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  return { total: jobs.length, jobs: jobs.slice(0, limit) };
}

async function resolveTrainingManifest(params = {}) {
  if (params.manifestPath) {
    const manifestPath = path.resolve(params.manifestPath);
    const job = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    return { job: { ...job, manifestPath: job.manifestPath || manifestPath }, manifestPath };
  }
  if (params.jobId) {
    const files = await scanFiles(TRAINING_JOB_DIR, new Set(['.json']), 2);
    for (const file of files) {
      try {
        const job = JSON.parse(await fs.readFile(file, 'utf-8'));
        if (job.id === params.jobId) return { job: { ...job, manifestPath: job.manifestPath || file }, manifestPath: file };
      } catch {}
    }
  }
  throw new Error('manifestPath or jobId is required');
}

async function saveTrainingManifest(job, manifestPath = job.manifestPath) {
  if (!manifestPath) throw new Error('manifestPath is required');
  job.manifestPath = manifestPath;
  job.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(job, null, 2), 'utf-8');
  await fs.rename(tmpPath, manifestPath);
}

function renderTrainingCommand(template, job) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = key === 'manifestPath' ? job.manifestPath : job[key];
    return value == null ? '' : String(value);
  });
}

async function startTrainingJob(params = {}) {
  const { job, manifestPath } = await resolveTrainingManifest(params);
  const commandTemplate = params.trainerCommand || job.trainerCommand;
  if (!commandTemplate) {
    return {
      ok: false,
      error: 'trainerCommand is required to launch training.',
      job,
      placeholders: ['{datasetDir}', '{outputName}', '{baseModel}', '{triggerWord}', '{resolution}', '{maxTrainSteps}', '{manifestPath}'],
    };
  }
  const command = renderTrainingCommand(commandTemplate, { ...job, manifestPath });
  if (params.dryRun) return { ok: true, dryRun: true, command, workingDir: params.workingDir || job.workingDir || job.datasetDir, job };
  if (!params.confirm) return { ok: false, error: 'start training requires confirm:true', command, job };
  if (trainingProcesses.has(job.id)) return { ok: false, error: 'training job is already running', jobId: job.id };

  const workingDir = params.workingDir || job.workingDir || job.datasetDir;
  const child = spawn(command, {
    cwd: workingDir,
    shell: true,
    windowsHide: true,
    env: { ...process.env },
  });
  const runtime = { child, logs: [], startedAt: new Date().toISOString(), command, workingDir, manifestPath, cancelRequested: false };
  trainingProcesses.set(job.id, runtime);
  job.status = 'running';
  job.pid = child.pid || null;
  job.command = command;
  job.workingDir = workingDir;
  job.startedAt = runtime.startedAt;
  job.exitCode = null;
  job.error = null;
  await saveTrainingManifest(job, manifestPath);

  const appendLog = async (line) => {
    runtime.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (runtime.logs.length > 500) runtime.logs.splice(0, runtime.logs.length - 500);
    job.logTail = runtime.logs.slice(-120);
    await saveTrainingManifest(job, manifestPath).catch(() => {});
  };
  child.stdout?.on('data', data => appendLog(String(data).trimEnd()));
  child.stderr?.on('data', data => appendLog(`[err] ${String(data).trimEnd()}`));
  child.on('error', async (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.completedAt = new Date().toISOString();
    trainingProcesses.delete(job.id);
    await saveTrainingManifest(job, manifestPath).catch(() => {});
  });
  child.on('exit', async (code, signal) => {
    job.status = runtime.cancelRequested ? 'cancelled' : (code === 0 ? 'completed' : 'failed');
    job.exitCode = code;
    job.signal = signal || null;
    job.completedAt = new Date().toISOString();
    job.logTail = runtime.logs.slice(-120);
    trainingProcesses.delete(job.id);
    await saveTrainingManifest(job, manifestPath).catch(() => {});
  });

  return { ok: true, jobId: job.id, status: job.status, pid: job.pid, command, workingDir, manifestPath };
}

async function getTrainingJobStatus(params = {}) {
  const { job, manifestPath } = await resolveTrainingManifest(params);
  const runtime = trainingProcesses.get(job.id);
  const tail = clampNumber(params.tail, 1, 500, 120);
  return {
    ok: true,
    jobId: job.id,
    status: runtime ? 'running' : job.status,
    pid: runtime?.child?.pid || job.pid || null,
    exitCode: job.exitCode ?? null,
    manifestPath,
    command: runtime?.command || job.command || job.trainerCommand || null,
    workingDir: runtime?.workingDir || job.workingDir || null,
    logTail: (runtime?.logs || job.logTail || []).slice(-tail),
    job,
  };
}

async function stopTrainingJob(params = {}) {
  const { job, manifestPath } = await resolveTrainingManifest(params);
  const runtime = trainingProcesses.get(job.id);
  if (!runtime) return { ok: false, jobId: job.id, status: job.status, error: 'training job is not running' };
  try {
    runtime.cancelRequested = true;
    runtime.child.kill('SIGTERM');
  } catch (err) {
    return { ok: false, jobId: job.id, error: err.message };
  }
  job.status = 'cancelled';
  job.cancelledAt = new Date().toISOString();
  job.logTail = runtime.logs.slice(-120);
  trainingProcesses.delete(job.id);
  await saveTrainingManifest(job, manifestPath);
  return { ok: true, jobId: job.id, status: 'cancelled', manifestPath };
}

async function getComfyVersionStatus(params = {}) {
  const cwd = path.resolve(params.comfyDir || getComfyDir());
  comfyDir = cwd;
  const [branch, commit, status, versionPy] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    runGit(cwd, ['rev-parse', '--short', 'HEAD']),
    runGit(cwd, ['status', '--short']),
    readTextIfExists(path.join(cwd, 'comfyui_version.py')),
  ]);
  const models = await collectModelInventory(path.join(cwd, 'models'));
  const customNodes = await listDirNames(path.join(cwd, 'custom_nodes'));
  const statusService = comfy || new ComfyUIService(serverUrl);
  const health = await statusService.healthCheck(3000);
  return {
    comfyDir: path.resolve(cwd),
    serverUrl,
    connected: health,
    pythonPath,
    git: {
      branch: branch.trim() || null,
      commit: commit.trim() || null,
      dirty: status.trim().length > 0,
      status: status.trim().split(/\r?\n/).filter(Boolean).slice(0, 50),
    },
    versionFile: versionPy.trim() || null,
    models,
    customNodes,
    recommendations: [
      'Before upgrading ComfyUI, stop the process and back up workflows plus custom_nodes.',
      'Keep Flux model dependencies grouped by workflow: unet, clip, vae, loras.',
      'Run workflow dependency checks after importing GitHub workflows.',
    ],
  };
}

async function manageComfyVersion(params = {}) {
  const action = params.action || 'status';
  const cwd = params.comfyDir || getComfyDir();
  const remote = params.remote || 'origin';
  const statusService = comfy || new ComfyUIService(serverUrl);
  const running = await statusService.healthCheck(1500);

  if (action === 'status') return await getComfyVersionStatus({ comfyDir: cwd });

  if (action === 'listTags') {
    const tags = await runGit(cwd, ['tag', '--sort=-creatordate']);
    return {
      ok: true,
      action,
      comfyDir: path.resolve(cwd),
      tags: tags.trim().split(/\r?\n/).filter(Boolean).slice(0, 100),
    };
  }

  if (action === 'fetch') {
    const result = await runGitDetailed(cwd, ['fetch', '--tags', '--prune', remote], 60000);
    return { ok: result.code === 0, action, comfyDir: path.resolve(cwd), remote, result, status: await getComfyVersionStatus({ comfyDir: cwd }) };
  }

  if (action === 'planUpdate') {
    const status = await getComfyVersionStatus({ comfyDir: cwd });
    const branch = status.git.branch || 'master';
    const local = status.git.commit;
    const remoteCommit = (await runGit(cwd, ['rev-parse', '--short', `${remote}/${branch}`])).trim();
    const log = await runGit(cwd, ['log', '--oneline', '--decorate', '--max-count=12', `${local || 'HEAD'}..${remote}/${branch}`]);
    return {
      ok: true,
      action,
      comfyDir: path.resolve(cwd),
      running,
      branch,
      local,
      remoteCommit: remoteCommit || null,
      hasRemoteAhead: !!log.trim(),
      pendingCommits: log.trim().split(/\r?\n/).filter(Boolean),
      nextSteps: [
        'Stop ComfyUI before applying updates.',
        'Run comfyManageVersion with action=fetch if remote state may be stale.',
        'Run comfyManageVersion with action=pull and confirm=true to fast-forward the current branch.',
        'Re-run comfyValidateWorkflow on production workflows after updating.',
      ],
    };
  }

  if (action === 'pull') {
    if (running) return { ok: false, action, error: 'Refusing to pull while ComfyUI is running. Stop it first.' };
    if (!params.confirm) return { ok: false, action, error: 'pull requires confirm:true' };
    const status = await getComfyVersionStatus({ comfyDir: cwd });
    const branch = status.git.branch || 'master';
    const result = await runGitDetailed(cwd, ['pull', '--ff-only', remote, branch], 120000);
    return { ok: result.code === 0, action, comfyDir: path.resolve(cwd), branch, result, status: await getComfyVersionStatus({ comfyDir: cwd }) };
  }

  if (action === 'checkout') {
    if (running) return { ok: false, action, error: 'Refusing to checkout while ComfyUI is running. Stop it first.' };
    if (!params.confirm) return { ok: false, action, error: 'checkout requires confirm:true' };
    if (!params.ref) return { ok: false, action, error: 'ref is required for checkout' };
    const current = await getComfyVersionStatus({ comfyDir: cwd });
    if (current.git.dirty) return { ok: false, action, error: 'Refusing checkout because ComfyUI worktree is dirty.', status: current };
    const result = await runGitDetailed(cwd, ['checkout', params.ref], 60000);
    return { ok: result.code === 0, action, comfyDir: path.resolve(cwd), ref: params.ref, result, status: await getComfyVersionStatus({ comfyDir: cwd }) };
  }

  return { ok: false, action, error: `Unknown version action: ${action}` };
}

function normalizeWorkflowObject(parsed) {
  let workflow, format;
  if (parsed?.nodes && parsed?.links) {
    workflow = editorToApi(parsed);
    if (!workflow) return { error: 'Error: Cannot auto-convert editor format. Load into ComfyUI web UI and Export -> API.' };
    format = 'editor (auto-converted)';
  } else if (parsed?.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)) {
    workflow = parsed.prompt;
    format = 'API (unwrapped)';
  } else {
    let hasClassType = false;
    for (const v of Object.values(parsed || {})) { if (v && typeof v === 'object' && 'class_type' in v) { hasClassType = true; break; } }
    if (!hasClassType) return { error: 'Error: Unrecognized workflow format.' };
    workflow = parsed;
    format = 'API';
  }
  workflow = stripWorkflowMetadata(workflow);
  let nodeCount = 0;
  for (const v of Object.values(workflow)) { if (v && typeof v === 'object' && 'class_type' in v) nodeCount++; }
  if (nodeCount === 0) return { error: 'Error: No ComfyUI nodes found.' };
  return { workflow, format, nodeCount };
}

function parseGithubUrl(url, params = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Invalid URL' }; }

  if (u.hostname === 'raw.githubusercontent.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return { ok: false, error: 'Invalid raw.githubusercontent.com URL' };
    return {
      ok: true,
      mode: 'blob',
      owner: parts[0],
      repo: parts[1],
      ref: params.ref || parts[2],
      path: params.path || parts.slice(3).join('/'),
      rawUrl: url,
    };
  }

  if (u.hostname !== 'github.com') return { ok: false, error: 'Only github.com and raw.githubusercontent.com URLs are supported' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { ok: false, error: 'GitHub URL must include owner and repo' };
  const owner = parts[0];
  const repo = parts[1];
  let mode = 'repo';
  let ref = params.ref || 'HEAD';
  let repoPath = params.path || '';

  if (parts[2] === 'blob' || parts[2] === 'raw') {
    mode = 'blob';
    ref = params.ref || parts[3] || 'HEAD';
    repoPath = params.path || parts.slice(4).join('/');
  } else if (parts[2] === 'tree') {
    mode = 'tree';
    ref = params.ref || parts[3] || 'HEAD';
    repoPath = params.path || parts.slice(4).join('/');
  } else if (parts.length > 2) {
    repoPath = params.path || parts.slice(2).join('/');
  }

  return { ok: true, mode, owner, repo, ref, path: repoPath };
}

async function listGithubJsonFiles(source, opts = {}) {
  if (source.mode === 'blob') {
    return [{
      name: path.posix.basename(source.path),
      relativePath: source.path,
      downloadUrl: source.rawUrl || githubRawUrl(source),
      htmlUrl: source.rawUrl || githubBlobUrl(source),
    }].filter(f => /\.json$/i.test(f.name));
  }

  const out = [];
  async function walk(dirPath) {
    if (out.length >= opts.limit) return;
    const items = await githubContents(source, dirPath);
    for (const item of items) {
      if (out.length >= opts.limit) break;
      if (item.type === 'file' && /\.json$/i.test(item.name)) {
        out.push({
          name: item.name,
          relativePath: item.path,
          downloadUrl: item.download_url || githubRawUrl({ ...source, path: item.path }),
          htmlUrl: item.html_url,
        });
      } else if (opts.recursive && item.type === 'dir') {
        await walk(item.path);
      }
    }
  }
  await walk(source.path || '');
  return out;
}

async function githubContents(source, repoPath) {
  const apiUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${encodeURIComponentPath(repoPath || '')}?ref=${encodeURIComponent(source.ref || 'HEAD')}`;
  const text = await fetchText(apiUrl, 20000, { Accept: 'application/vnd.github+json', 'User-Agent': 'AnoClaw-ComfyUI-Plugin' });
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  return [data];
}

function githubRawUrl(source) {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref || 'HEAD'}/${source.path}`;
}

function githubBlobUrl(source) {
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.ref || 'HEAD'}/${source.path}`;
}

function parseGiteeUrl(url, params = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Invalid Gitee URL' }; }
  if (u.hostname !== 'gitee.com') return { ok: false, error: 'Only gitee.com URLs are supported for Gitee discovery' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { ok: false, error: 'Gitee URL must include owner and repo' };
  const owner = parts[0];
  const repo = parts[1];
  let mode = 'repo';
  let ref = params.ref || 'master';
  let repoPath = params.path || '';

  if (parts[2] === 'blob' || parts[2] === 'raw') {
    mode = 'blob';
    ref = params.ref || parts[3] || 'master';
    repoPath = params.path || parts.slice(4).join('/');
  } else if (parts[2] === 'tree') {
    mode = 'tree';
    ref = params.ref || parts[3] || 'master';
    repoPath = params.path || parts.slice(4).join('/');
  } else if (parts.length > 2) {
    repoPath = params.path || parts.slice(2).join('/');
  }
  return { ok: true, mode, owner, repo, ref, path: repoPath };
}

async function listGiteeJsonFiles(source, opts = {}) {
  if (source.mode === 'blob') {
    return [{
      name: path.posix.basename(source.path),
      relativePath: source.path,
      downloadUrl: giteeRawUrl(source),
      htmlUrl: giteeBlobUrl(source),
    }].filter(f => /\.json$/i.test(f.name));
  }

  const out = [];
  async function walk(dirPath) {
    if (out.length >= opts.limit) return;
    const items = await giteeContents(source, dirPath);
    for (const item of items) {
      if (out.length >= opts.limit) break;
      const itemPath = item.path || item.name || '';
      if (item.type === 'file' && /\.json$/i.test(item.name || itemPath)) {
        out.push({
          name: item.name || path.posix.basename(itemPath),
          relativePath: itemPath,
          downloadUrl: item.download_url || giteeRawUrl({ ...source, path: itemPath }),
          htmlUrl: item.html_url || giteeBlobUrl({ ...source, path: itemPath }),
        });
      } else if (opts.recursive && item.type === 'dir') {
        await walk(itemPath);
      }
    }
  }
  await walk(source.path || '');
  return out;
}

async function giteeContents(source, repoPath) {
  const apiPath = encodeURIComponentPath(repoPath || '');
  const apiUrl = `https://gitee.com/api/v5/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${apiPath}?ref=${encodeURIComponent(source.ref || 'master')}`;
  const text = await fetchText(apiUrl, 20000, { 'User-Agent': 'AnoClaw-ComfyUI-Plugin' });
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  return [data];
}

function giteeRawUrl(source) {
  return `https://gitee.com/${source.owner}/${source.repo}/raw/${source.ref || 'master'}/${source.path}`;
}

function giteeBlobUrl(source) {
  return `https://gitee.com/${source.owner}/${source.repo}/blob/${source.ref || 'master'}/${source.path}`;
}

function encodeURIComponentPath(value) {
  return String(value || '').split('/').map(encodeURIComponent).join('/');
}

async function fetchText(url, timeoutMs = 15000, headers = {}) {
  return await fetchTextWithNode(url, timeoutMs, headers, 0);
}

function fetchTextWithNode(url, timeoutMs, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { reject(err); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 5) {
        res.resume();
        const nextUrl = new URL(location, parsed).toString();
        fetchTextWithNode(nextUrl, timeoutMs, headers, redirectCount + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status} ${res.statusMessage || ''}: ${text.slice(0, 300)}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function stripWorkflowMetadata(workflow) {
  const cleaned = {};
  for (const [key, value] of Object.entries(workflow || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'class_type' in value) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

async function checkModelDependencies(dependencies) {
  const results = [];
  for (const dep of dependencies || []) {
    const candidates = modelCandidatePaths(dep.folder, dep.value);
    let found = null;
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          found = { path: candidate, size: stat.size, mtime: stat.mtimeMs };
          break;
        }
      } catch {}
    }
    results.push({
      ...dep,
      exists: !!found,
      path: found?.path || null,
      size: found?.size || 0,
      candidatePaths: candidates,
    });
  }
  return results;
}

async function checkNodeClassDependencies(workflow) {
  const classes = new Map();
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const classType = node?.class_type;
    if (!classType) continue;
    const list = classes.get(classType) || [];
    list.push(nodeId);
    classes.set(classType, list);
  }
  if (!comfy) comfy = new ComfyUIService(serverUrl);
  let objectInfo;
  try {
    objectInfo = await comfy.objectInfo(8000);
  } catch (err) {
    return {
      checked: false,
      reason: `ComfyUI object_info unavailable: ${err.message}`,
      total: classes.size,
      available: [],
      missing: [],
      classes: [...classes.entries()].map(([classType, nodeIds]) => ({ classType, nodeIds, exists: null })),
    };
  }
  const available = new Set(Object.keys(objectInfo || {}));
  const items = [...classes.entries()].map(([classType, nodeIds]) => ({
    classType,
    nodeIds,
    exists: available.has(classType),
  }));
  return {
    checked: true,
    total: items.length,
    availableCount: items.filter(item => item.exists).length,
    missingCount: items.filter(item => !item.exists).length,
    available: items.filter(item => item.exists),
    missing: items.filter(item => !item.exists),
    classes: items,
  };
}

function modelCandidatePaths(folder, value) {
  const safeValue = String(value || '').replace(/\\/g, '/');
  const aliases = MODEL_FOLDER_ALIASES[folder] || [folder];
  const roots = aliases.map(alias => alias === 'input' ? path.join(getComfyDir(), 'input') : path.join(getComfyDir(), 'models', alias));
  return roots.map(root => path.join(root, safeValue));
}

async function checkWorkflowInputs(workflow, referenceImage) {
  const results = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const cls = node.class_type || '';
    if (!['LoadImage', 'LoadImageOutput', 'LoadImageMask'].includes(cls)) continue;
    const value = node.inputs?.image;
    if (!value || isLink(value)) continue;
    let existingPath = null;
    const candidates = [
      path.join(getComfyDir(), 'input', String(value)),
      path.resolve(String(value)),
    ];
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          existingPath = candidate;
          break;
        }
      } catch {}
    }
    let referenceOk = false;
    if (referenceImage) {
      try {
        const stat = await fs.stat(referenceImage);
        referenceOk = stat.isFile();
      } catch {}
    }
    const looksPlaceholder = /REPLACE|UPLOAD|PLACEHOLDER|YOUR_IMAGE/i.test(String(value));
    results.push({
      nodeId,
      classType: cls,
      value,
      exists: !!existingPath,
      path: existingPath,
      referenceImage: referenceOk ? path.resolve(referenceImage) : null,
      satisfied: !!existingPath || referenceOk || !looksPlaceholder,
      requiresReferenceImage: looksPlaceholder && !existingPath,
    });
  }
  return results;
}

function checkParameterOverrides(schema, extraParams) {
  return Object.keys(extraParams || {}).map(name => ({
    name,
    exists: !!schema.parameters[name],
    target: schema.parameters[name] || null,
  }));
}

async function scanFiles(root, extensions, maxDepth = 8) {
  const resolved = path.resolve(root);
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  await walk(resolved, 0);
  return out;
}

function deriveTagsFromText(text) {
  return String(text || '')
    .replace(/[_-]+/g, ' ')
    .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length >= 2 && !/^\d+$/.test(s))
    .slice(0, 24);
}

function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const tag of tags.flatMap(t => Array.isArray(t) ? t : [t])) {
    const cleaned = String(tag || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeFileBase(value) {
  return String(value || 'workflow').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow';
}

function getPluginDir() {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

async function readTextIfExists(file) {
  try { return await fs.readFile(file, 'utf-8'); } catch { return ''; }
}

async function listDirNames(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch { return []; }
}

async function runGit(cwd, args) {
  try {
    const { execFile } = await import('child_process');
    return await new Promise((resolve) => {
      execFile('git', args, { cwd, windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
        resolve(err ? String(stderr || err.message) : String(stdout || ''));
      });
    });
  } catch (err) {
    return String(err.message || err);
  }
}

async function runGitDetailed(cwd, args, timeout = 10000) {
  try {
    const { execFile } = await import('child_process');
    return await new Promise((resolve) => {
      execFile('git', args, { cwd, windowsHide: true, timeout }, (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          command: `git ${args.join(' ')}`,
        });
      });
    });
  } catch (err) {
    return { code: 1, stdout: '', stderr: String(err.message || err), command: `git ${args.join(' ')}` };
  }
}

async function collectModelInventory(modelsDir) {
  const files = await scanFiles(modelsDir, new Set(['.safetensors', '.ckpt', '.pt', '.pth']), 5);
  const byType = {};
  for (const file of files) {
    const rel = path.relative(modelsDir, file);
    const type = rel.split(path.sep)[0] || 'root';
    let stat = null;
    try { stat = await fs.stat(file); } catch {}
    if (!byType[type]) byType[type] = [];
    byType[type].push({ path: file, name: path.basename(file), size: stat?.size || 0, mtime: stat?.mtimeMs || 0 });
  }
  for (const list of Object.values(byType)) list.sort((a, b) => a.name.localeCompare(b.name));
  return byType;
}

async function handleDownload(params) {
  const url = params.url;
  const savePath = params.workflowPath;
  if (!url) return 'Error: url is required for download.';
  if (!savePath) return 'Error: workflowPath is required for download.';

  let rawUrl = url;
  const blobMatch = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/);
  if (blobMatch) {
    const parts = blobMatch[3].split('/');
    const ref = parts.shift();
    rawUrl = `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${ref}/${parts.join('/')}`;
  }

  let text;
  try {
    text = await fetchText(rawUrl, 15000);
  } catch (err) { return `Error: download failed: ${err.message}`; }

  const trimmed = text.trim();
  const firstCode = trimmed.charCodeAt(0);
  if ((firstCode === 0x89 || firstCode === 0xfffd) && trimmed.slice(1, 4) === 'PNG') {
    return 'Error: This is a PNG with embedded workflow metadata. Load it into ComfyUI web UI and Export -> API format.';
  }

  let workflow, format;
  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalizeWorkflowObject(parsed);
    if (!normalized.workflow) return normalized.error + ' Got keys: ' + Object.keys(parsed).slice(0, 10).join(', ');
    workflow = normalized.workflow;
    format = normalized.format;
  } catch { return 'Error: File is not valid JSON.'; }

  let nodeCount = 0;
  for (const v of Object.values(workflow)) { if (v && typeof v === 'object' && 'class_type' in v) nodeCount++; }
  if (nodeCount === 0) return 'Error: No ComfyUI nodes found.';

  await fs.mkdir(path.dirname(path.resolve(savePath)), { recursive: true });
  await fs.writeFile(path.resolve(savePath), JSON.stringify(workflow, null, 2), 'utf-8');

  const schema = comfy.extractSchema(workflow);
  const modelNames = schema.modelDependencies.map(m => m.value).join(', ');
  const paramNames = Object.keys(schema.parameters).join(', ');
  return `Downloaded -> ${path.resolve(savePath)}\nFormat: ${format}. Nodes: ${nodeCount}. ${schema.summary.parameterCount} params, ${schema.summary.modelDepCount} deps.\nModels: ${modelNames || '(none)'}\nParams: ${paramNames || '(none)'}`;
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
    negativePrompt: params.negativePrompt,
    referenceImage: params.referenceImage, denoise: params.denoise,
    steps: params.steps, seed: params.seed, width: params.width, height: params.height,
    outputDir: params.outputDir,
    extraParams: params.extraParams,
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
  const cwd = params.comfyDir || getComfyDir();
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
        void refreshComfyUISlot();
        resolve(JSON.stringify({ error: `Failed to start: ${err.message}` }, null, 2));
      });

      child.on('exit', (code, signal) => {
        addLog(`Process exited (code=${code}, signal=${signal})`);
        comfyProcess = null; processPid = null; connected = false;
        void refreshComfyUISlot();
      });

      setTimeout(async () => {
        connected = await testConnection();
        await refreshComfyUISlot();
        resolve(JSON.stringify({
          started: true, pid: processPid, connected, command: `${python} main.py --listen ${listen} --port ${port}`, cwd,
          message: connected ? 'ComfyUI started and responding' : 'ComfyUI process launched (waiting for server - check logs)',
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
  await refreshComfyUISlot();
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
  const outputDir = q.get('dir') || getDefaultOutputDir();
  
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

export async function assetDataRoute(request) {
  try {
    const q = queryObject(request);
    const requested = String(q.path || '').trim();
    if (!requested) return { status: 400, body: { error: 'path is required' } };

    const resolved = path.resolve(requested);
    const roots = [
      getDefaultOutputDir(),
      path.join(getComfyDir(), 'output'),
    ].map(root => path.resolve(root));
    if (!roots.some(root => isPathInside(resolved, root))) {
      return { status: 403, body: { error: 'Asset path is outside the ComfyUI output directory.' } };
    }

    const ext = path.extname(resolved).toLowerCase();
    const isImage = SUPPORTED_IMAGE_EXTENSIONS.has(ext);
    const isVideo = SUPPORTED_VIDEO_EXTENSIONS.has(ext);
    if (!isImage && !isVideo) {
      return { status: 415, body: { error: `Preview is not supported for ${ext || 'this file type'}.` } };
    }

    const stat = await fs.stat(resolved);
    const maxPreviewBytes = isVideo ? 256 * 1024 * 1024 : 24 * 1024 * 1024;
    if (stat.size > maxPreviewBytes) {
      return { status: 413, body: { error: `Preview file is too large (${stat.size} bytes).` } };
    }

    const buffer = await fs.readFile(resolved);
    const mimeType = mimeForExtension(ext);
    return {
      status: 200,
      body: {
        path: resolved,
        filename: path.basename(resolved),
        size: stat.size,
        kind: isVideo ? 'video' : 'image',
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: `Failed to read asset preview: ${err.message}` } };
  }
}

function isPathInside(filePath, rootPath) {
  const file = path.resolve(filePath).toLowerCase();
  const root = path.resolve(rootPath).toLowerCase();
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function mimeForExtension(ext) {
  switch (String(ext || '').toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.avi':
      return 'video/x-msvideo';
    case '.png':
    default:
      return 'image/png';
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
    const inputDir = path.join(getComfyDir(), 'input');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, filename), buffer);
    
    return { status: 200, body: { name: filename, size: buffer.length } };
  } catch (err) {
    return { status: 500, body: { error: `Upload failed: ${err.message}` } };
  }
}

export async function listWorkflowsRoute(request) {
  try {
    return { status: 200, body: await listWorkflowLibrary(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function importWorkflowRoute(request) {
  try {
    const result = await importWorkflow(request.body || {});
    return { status: String(result).startsWith('Error:') ? 400 : 200, body: { result } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function discoverGithubWorkflowsRoute(request) {
  try {
    const result = await discoverGithubWorkflows(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function importGithubWorkflowsRoute(request) {
  try {
    const result = await importGithubWorkflows(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function listWorkflowSourcesRoute(request) {
  try {
    return { status: 200, body: listWorkflowSources(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function discoverCommunityWorkflowsRoute(request) {
  try {
    const result = await discoverCommunityWorkflows(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function importCommunityWorkflowsRoute(request) {
  try {
    const result = await importCommunityWorkflows(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function validateWorkflowRoute(request) {
  try {
    const result = await diagnoseWorkflow(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function listModelsRoute(request) {
  try {
    return { status: 200, body: await listModels(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function downloadModelRoute(request) {
  try {
    const result = await downloadModel(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function listOutputsRoute(request) {
  try {
    return { status: 200, body: await listOutputAssets(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function listJobsRoute(request) {
  try {
    return { status: 200, body: await listJobs(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function submitJobRoute(request) {
  try {
    const result = await submitAsyncJob(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function jobStatusRoute(request) {
  try {
    const result = await getAsyncJobStatus(queryObject(request));
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function cancelJobRoute(request) {
  try {
    const result = await cancelAsyncJob(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function enhancePromptRoute(request) {
  try {
    const result = await enhancePrompt(request.body || {});
    return { status: 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function tagDatasetRoute(request) {
  try {
    const result = await tagDataset(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function prepareTrainingJobRoute(request) {
  try {
    const result = await prepareTrainingJob(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function listTrainingJobsRoute(request) {
  try {
    return { status: 200, body: await listTrainingJobs(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function startTrainingJobRoute(request) {
  try {
    const result = await startTrainingJob(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function trainingJobStatusRoute(request) {
  try {
    const result = await getTrainingJobStatus(queryObject(request));
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function stopTrainingJobRoute(request) {
  try {
    const result = await stopTrainingJob(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function versionStatusRoute(request) {
  try {
    return { status: 200, body: await getComfyVersionStatus(queryObject(request)) };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

export async function manageVersionRoute(request) {
  try {
    const result = await manageComfyVersion(request.body || {});
    return { status: result.ok === false ? 400 : 200, body: result };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

function queryObject(request) {
  const q = request?.query || '';
  if (typeof q === 'string') return Object.fromEntries(new URLSearchParams(q));
  if (q instanceof URLSearchParams) return Object.fromEntries(q);
  return q || {};
}
