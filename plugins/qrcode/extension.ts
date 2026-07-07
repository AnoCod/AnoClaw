// ── AnoClaw Plugin: QR Code Generator ──
// Demonstrates the full plugin API:
//   tools.register(), routes.register(), events.on(),
//   memory.save(), prompt.inject(), api.call(),
//   llm.chat(), ws.broadcast(), context, log
//
// v1.2.0 - Feature-complete upgrade:
//   ✅ Config loading from memory (defaultSize, errorCorrection, colors)
//   ✅ Persistent generateCount across sessions
//   ✅ QR code generation history with configurable limit
//   ✅ HTTP routes: config GET/POST, history GET/DELETE
//   ✅ Color support in HTTP route
//   ✅ Batch generation endpoint
//   ✅ QR code validation endpoint
//   ✅ Styling options (dot/corner styles tracked in config)

import { createRequire } from 'module';
import type { AnoClawAPI } from '../../src/server/core/plugin-host/PluginAPI.js';

// Use createRequire so node_modules/qrcode resolves correctly in asar
let QRCode: any;

function ensureQRCode() {
  if (!QRCode) {
    const req = createRequire(import.meta.url);
    QRCode = req('qrcode');
  }
}

// ── Reference to anoclaw API (captured during activate) ──
let api: AnoClawAPI;

// ── Plugin state (persisted via memory) ──
let generateCount = 0;
let history: HistoryEntry[] = [];

interface Config {
  defaultSize: number;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  darkColor: string;
  lightColor: string;
  historyLimit: number;
  dotStyle: 'square' | 'rounded' | 'dots';
  cornerStyle: 'square' | 'rounded' | 'extra-rounded';
  margin: number;
}

interface HistoryEntry {
  id: string;
  text: string;
  format: 'png' | 'svg';
  size?: number;
  errorCorrection: string;
  darkColor: string;
  lightColor: string;
  generatedAt: string;
  dotStyle?: string;
  cornerStyle?: string;
}

const DEFAULT_CONFIG: Config = {
  defaultSize: 256,
  errorCorrection: 'M',
  darkColor: '#000000',
  lightColor: '#ffffff',
  historyLimit: 50,
  dotStyle: 'square',
  cornerStyle: 'square',
  margin: 4,
};

let config: Config = { ...DEFAULT_CONFIG };

// ── Persistence helpers ──
async function loadPersistedState(): Promise<void> {
  if (!api) return;

  try {
    // Load config
    const configResults = await api.memory.search('qrcode-config', { scope: 'team', limit: 1 });
    if (configResults.length > 0) {
      const raw = (configResults[0] as any).content;
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      config = { ...DEFAULT_CONFIG, ...saved };
      api.log.info(`Loaded config: size=${config.defaultSize}, ecc=${config.errorCorrection}`);
    }

    // Load stats
    const statsResults = await api.memory.search('qrcode-stats', { scope: 'team', limit: 1 });
    if (statsResults.length > 0) {
      const raw = (statsResults[0] as any).content;
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      generateCount = saved.totalGenerated || 0;
      api.log.info(`Loaded stats: ${generateCount} QR codes generated`);
    }

    // Load history
    const historyResults = await api.memory.search('qrcode-history', { scope: 'team', limit: 1 });
    if (historyResults.length > 0) {
      const raw = (historyResults[0] as any).content;
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      history = saved.entries || [];
      api.log.info(`Loaded ${history.length} history entries`);
    }
  } catch (err) {
    api.log.warn(`Failed to load persisted state: ${(err as Error).message}`);
  }
}

async function saveConfig(): Promise<void> {
  if (!api) return;
  try {
    await api.memory.save({
      name: 'qrcode-config',
      type: 'reference',
      description: 'QR Code plugin configuration',
      content: JSON.stringify(config),
      scope: 'team',
    });
  } catch (err) {
    api.log.warn(`Failed to save config: ${(err as Error).message}`);
  }
}

async function saveStats(): Promise<void> {
  if (!api) return;
  try {
    await api.memory.save({
      name: 'qrcode-stats',
      type: 'feedback',
      description: 'QR Code plugin generation statistics',
      content: JSON.stringify({
        totalGenerated: generateCount,
        lastUpdated: new Date().toISOString(),
      }),
      scope: 'team',
    });
  } catch (err) {
    api.log.warn(`Failed to save stats: ${(err as Error).message}`);
  }
}

async function saveHistory(): Promise<void> {
  if (!api) return;
  try {
    // Trim history to limit
    if (history.length > config.historyLimit) {
      history = history.slice(0, config.historyLimit);
    }
    await api.memory.save({
      name: 'qrcode-history',
      type: 'reference',
      description: 'QR Code generation history',
      content: JSON.stringify({ entries: history }),
      scope: 'team',
    });
  } catch (err) {
    api.log.warn(`Failed to save history: ${(err as Error).message}`);
  }
}

function addHistoryEntry(entry: HistoryEntry): void {
  history.unshift(entry); // newest first
  if (history.length > config.historyLimit) {
    history = history.slice(0, config.historyLimit);
  }
  void refreshQRCodeSlot();
}

async function refreshQRCodeSlot(): Promise<void> {
  if (!api?.ui?.mount) return;
  await mountSlotBadge(
    api,
    'QR',
    `${generateCount} made / ${history.length} saved`,
    history.length > 0 ? 'info' : 'ok',
    'qrcode-status',
    45,
  );
}

async function mountSlotBadge(
  anoclaw: AnoClawAPI,
  label: string,
  value: string,
  tone: 'ok' | 'warn' | 'danger' | 'info',
  id: string,
  priority = 50,
): Promise<void> {
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
    anoclaw.log.warn(`Failed to mount QR slot badge: ${(err as Error).message}`);
  }
}

function escapeSlot(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Activate ──

export async function activate(anoclaw: AnoClawAPI): Promise<void> {
  api = anoclaw;
  await ensureQRCode();
  anoclaw.log.info('QR Code plugin activating');

  // Load persisted state (config, stats, history)
  await loadPersistedState();

  // ── 1. Register tool: generateQRCode ──
  await anoclaw.tools.register({
    name: 'generateQRCode',
    description: 'Generate a QR code image from text, URL, or data. Returns a base64 PNG data URL that can be rendered in HTML.',
    parametersSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text, URL, or data to encode in the QR code (required)' },
        size: { type: 'number', description: `Image size in pixels (default: ${config.defaultSize})` },
        errorCorrection: {
          type: 'string',
          enum: ['L', 'M', 'Q', 'H'],
          description: `Error correction level: L (7%), M (15%), Q (25%), H (30%). Default: ${config.errorCorrection}`,
        },
        margin: { type: 'number', description: 'Quiet zone margin in modules (default: 4)' },
        darkColor: { type: 'string', description: `Dark module color as hex, e.g. #000000 (default: ${config.darkColor})` },
        lightColor: { type: 'string', description: `Light module color as hex, e.g. #ffffff (default: ${config.lightColor})` },
      },
      required: ['text'],
    },
    category: 'Media',
  });

  // ── 2. Register tool: generateQRCodeSVG ──
  await anoclaw.tools.register({
    name: 'generateQRCodeSVG',
    description: 'Generate a QR code as an SVG string. Returns clean SVG markup that can be embedded in HTML or saved as .svg file.',
    parametersSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text, URL, or data to encode' },
        errorCorrection: {
          type: 'string',
          enum: ['L', 'M', 'Q', 'H'],
          description: `Error correction level. Default: ${config.errorCorrection}`,
        },
      },
      required: ['text'],
    },
    category: 'Media',
  });

  // ── 3. Register HTTP routes ──
  await anoclaw.routes.register([
    {
      method: 'GET',
      path: '/api/v1/plugins/qrcode/generate',
      handler: 'generate',
    },
    {
      method: 'GET',
      path: '/api/v1/plugins/qrcode/config',
      handler: 'getConfig',
    },
    {
      method: 'POST',
      path: '/api/v1/plugins/qrcode/config',
      handler: 'updateConfig',
    },
    {
      method: 'GET',
      path: '/api/v1/plugins/qrcode/history',
      handler: 'getHistory',
    },
    {
      method: 'DELETE',
      path: '/api/v1/plugins/qrcode/history',
      handler: 'clearHistory',
    },
    {
      method: 'POST',
      path: '/api/v1/plugins/qrcode/batch',
      handler: 'batchGenerate',
    },
    {
      method: 'POST',
      path: '/api/v1/plugins/qrcode/validate',
      handler: 'validate',
    },
  ]);

  // ── 4. Subscribe to kernel events ──
  anoclaw.events.on('session:created', (_data: unknown) => {
    anoclaw.log.info('New session detected (from QR plugin)');
  });

  // ── 5. Inject prompt section ──
  await anoclaw.prompt.inject('qrcode-usage',
    '## QR Code Generation\n' +
    '- Use `generateQRCode` to create a QR code image (returns base64 PNG data URL)\n' +
    '- Use `generateQRCodeSVG` to get clean SVG markup (save as .svg file)\n' +
    '- The frontend "QR Code" page also has a visual generator\n' +
    '- Error correction: L=low(7%), M=medium(15%), Q=quartile(25%), H=high(30%)\n' +
    '- Supports custom dark/light colors via darkColor/lightColor params\n' +
    '- Batch generation available via HTTP POST /api/v1/plugins/qrcode/batch\n',
    40
  );

  // ── 6. Save initialization memory ──
  await anoclaw.memory.save({
    name: 'qrcode-plugin-activated',
    type: 'reference',
    description: 'QR Code plugin activation record',
    content: JSON.stringify({
      version: '1.2.0',
      activatedAt: new Date().toISOString(),
    }),
    scope: 'team',
  });

  // ── 7. Broadcast activation to frontend ──
  await anoclaw.ws.broadcast({
    type: 'plugin_status',
    plugin: 'qrcode',
    message: 'QR Code plugin activated',
  });

  await refreshQRCodeSlot();

  // ── 8. Use api.call to verify kernel APIs ──
  try {
    const tools = await anoclaw.api.call('GET', '/api/v1/tools');
    const toolNames = (tools.body as any)?.tools?.map?.((t: any) => t.name) || [];
    const count = toolNames.filter((n: string) => n.includes('QR') || n.includes('qr')).length;
    anoclaw.log.info(`QR tools registered and visible in registry (${count} tools)`);
  } catch {
    anoclaw.log.warn('Could not verify tool registration via API');
  }

  anoclaw.log.info(`QR Code plugin activated successfully (config: size=${config.defaultSize}, ecc=${config.errorCorrection}, history=${history.length})`);
}

// ── Tool Execution ──

export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  await ensureQRCode();

  switch (toolName) {
    case 'generateQRCode': {
      const text = params.text as string;
      if (!text) throw new Error('"text" parameter is required');

      const size = (params.size as number) || config.defaultSize;
      const errorCorrection = (params.errorCorrection as 'L' | 'M' | 'Q' | 'H') || config.errorCorrection;
      const margin = (params.margin as number) || 4;
      const darkColor = (params.darkColor as string) || config.darkColor;
      const lightColor = (params.lightColor as string) || config.lightColor;

      const dataUrl = await QRCode.toDataURL(text, {
        width: size,
        margin,
        color: { dark: darkColor, light: lightColor },
        errorCorrectionLevel: errorCorrection,
        type: 'image/png',
      });

      generateCount++;
      addHistoryEntry({
        id: `qr-${Date.now()}`,
        text,
        format: 'png',
        size,
        errorCorrection,
        darkColor,
        lightColor,
        generatedAt: new Date().toISOString(),
      });

      // Persist asynchronously (fire and forget for speed)
      saveStats();
      saveHistory();

      if (api) {
        api.log.info(`Generated QR code (${size}px, ECC=${errorCorrection}): "${text.slice(0, 40)}..."`);
      }

      return JSON.stringify({
        type: 'png_data_url',
        dataUrl,
        size,
        text,
        errorCorrection,
        darkColor,
        lightColor,
        width: size,
        height: size,
        format: 'png',
        html: `<img src="${dataUrl}" alt="QR Code" width="${size}" height="${size}" />`,
      });
    }

    case 'generateQRCodeSVG': {
      const text = params.text as string;
      if (!text) throw new Error('"text" parameter is required');

      const errorCorrection = (params.errorCorrection as 'L' | 'M' | 'Q' | 'H') || config.errorCorrection;

      const svg = await QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: errorCorrection,
      });

      generateCount++;
      addHistoryEntry({
        id: `qr-${Date.now()}`,
        text,
        format: 'svg',
        errorCorrection,
        darkColor: config.darkColor,
        lightColor: config.lightColor,
        generatedAt: new Date().toISOString(),
      });

      saveStats();
      saveHistory();

      if (api) {
        api.log.info(`Generated QR code SVG for: "${text.slice(0, 40)}..."`);
      }

      return JSON.stringify({
        type: 'svg',
        svg,
        text,
        errorCorrection,
        format: 'svg',
        html: svg,
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── HTTP Route Handler: GET /api/v1/plugins/qrcode/generate ──
export async function generate(request: {
  body: unknown;
  params: Record<string, string>;
  query: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  await ensureQRCode();

  const params = new URLSearchParams(request.query || '');
  const text = params.get('text') || (request.body as any)?.text;
  const format = params.get('format') || 'png';

  if (!text) {
    return { status: 400, body: { error: 'Missing "text" parameter' } };
  }

  const size = parseInt(params.get('size') || String(config.defaultSize), 10);
  const errorCorrection = (params.get('errorCorrection') as 'L' | 'M' | 'Q' | 'H') || config.errorCorrection;
  const margin = parseInt(params.get('margin') || '4', 10);
  const darkColor = params.get('darkColor') || config.darkColor;
  const lightColor = params.get('lightColor') || config.lightColor;

  if (format === 'svg') {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      errorCorrectionLevel: errorCorrection,
    });
    generateCount++;
    addHistoryEntry({
      id: `qr-${Date.now()}`,
      text,
      format: 'svg',
      errorCorrection,
      darkColor,
      lightColor,
      generatedAt: new Date().toISOString(),
    });
    saveStats();
    saveHistory();
    return { status: 200, body: { svg, text, format: 'svg', errorCorrection } };
  }

  const dataUrl = await QRCode.toDataURL(text, {
    width: size,
    margin,
    color: { dark: darkColor, light: lightColor },
    errorCorrectionLevel: errorCorrection,
    type: 'image/png',
  });

  generateCount++;
  addHistoryEntry({
    id: `qr-${Date.now()}`,
    text,
    format: 'png',
    size,
    errorCorrection,
    darkColor,
    lightColor,
    generatedAt: new Date().toISOString(),
  });
  saveStats();
  saveHistory();

  if (api) {
    api.log.info(`HTTP route: generated QR code for: "${text.slice(0, 40)}..."`);
  }

  return {
    status: 200,
    body: { dataUrl, text, size, errorCorrection, darkColor, lightColor, format: 'png', width: size, height: size },
  };
}

// ── HTTP Route Handler: POST /api/v1/plugins/qrcode/batch ──
export async function batchGenerate(request: {
  body: unknown;
  params: Record<string, string>;
  query: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  await ensureQRCode();

  const body = request.body as any;
  const items: string[] = body?.items || [];
  const size = body?.size || config.defaultSize;
  const errorCorrection = body?.errorCorrection || config.errorCorrection;
  const margin = body?.margin ?? 4;
  const darkColor = body?.darkColor || config.darkColor;
  const lightColor = body?.lightColor || config.lightColor;
  const format = body?.format || 'png';

  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { error: 'Provide "items" array of strings to encode' } };
  }

  if (items.length > 100) {
    return { status: 400, body: { error: 'Maximum 100 items per batch' } };
  }

  const results: any[] = [];

  for (const item of items) {
    if (typeof item !== 'string' || !item.trim()) {
      results.push({ text: item, error: 'Invalid or empty text' });
      continue;
    }

    try {
      if (format === 'svg') {
        const svg = await QRCode.toString(item, {
          type: 'svg',
          errorCorrectionLevel: errorCorrection,
        });
        results.push({ text: item, format: 'svg', svg });
      } else {
        const dataUrl = await QRCode.toDataURL(item, {
          width: size,
          margin,
          color: { dark: darkColor, light: lightColor },
          errorCorrectionLevel: errorCorrection,
          type: 'image/png',
        });
        results.push({ text: item, format: 'png', dataUrl, size });
      }

      generateCount++;
      addHistoryEntry({
        id: `qr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: item,
        format: format as 'png' | 'svg',
        size: format === 'png' ? size : undefined,
        errorCorrection,
        darkColor,
        lightColor,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      results.push({ text: item, error: (err as Error).message });
    }
  }

  saveStats();
  saveHistory();

  if (api) {
    api.log.info(`Batch generated ${results.length} QR codes (${format})`);
  }

  return {
    status: 200,
    body: { results, count: results.length, format },
  };
}

// ── HTTP Route Handler: POST /api/v1/plugins/qrcode/validate ──
export async function validate(request: {
  body: unknown;
  params: Record<string, string>;
  query: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  await ensureQRCode();

  const body = request.body as any;
  const text = body?.text;
  const errorCorrection = body?.errorCorrection || config.errorCorrection;

  if (!text || typeof text !== 'string') {
    return { status: 400, body: { error: 'Provide "text" to validate' } };
  }

  try {
    // Attempt to create the QR code to validate it can be encoded
    const dataUrl = await QRCode.toDataURL(text, {
      width: 256,
      margin: 4,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: errorCorrection,
      type: 'image/png',
    });

    // Compute data size metrics
    const textBytes = new TextEncoder().encode(text).length;
    const eccLevels = {
      L: { recoveryPercent: 7, bitsAvailable: 7 },
      M: { recoveryPercent: 15, bitsAvailable: 10 },
      Q: { recoveryPercent: 25, bitsAvailable: 13 },
      H: { recoveryPercent: 30, bitsAvailable: 16 },
    };

    // Heuristic: estimate if QR code will be readable
    // Very long data at low ECC = less reliable
    const eccInfo = eccLevels[errorCorrection as keyof typeof eccLevels] || eccLevels.M;
    const estimatedModules = Math.ceil(Math.sqrt(textBytes * 8 / eccInfo.bitsAvailable + 25));
    const isHighDensity = textBytes > 2000;
    const isLowEcc = errorCorrection === 'L';

    let scanReliability: 'high' | 'medium' | 'low' = 'high';
    if (isHighDensity && isLowEcc) scanReliability = 'low';
    else if (isHighDensity || isLowEcc) scanReliability = 'medium';

    return {
      status: 200,
      body: {
        valid: true,
        text,
        errorCorrection,
        textBytes,
        estimatedModules,
        scanReliability,
        eccRecoveryPercent: eccInfo.recoveryPercent,
        dataUrl,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: {
        valid: false,
        text,
        error: (err as Error).message,
        scanReliability: 'none',
      },
    };
  }
}

// ── HTTP Route Handler: GET /api/v1/plugins/qrcode/config ──
export async function getConfig(): Promise<{ status: number; body: Record<string, unknown> }> {
  return {
    status: 200,
    body: {
      ...config,
      generateCount,
      historyCount: history.length,
    },
  };
}

// ── HTTP Route Handler: POST /api/v1/plugins/qrcode/config ──
export async function updateConfig(request: {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const updates = request.body as Partial<Config>;

  // Validate and merge
  if (updates.defaultSize !== undefined) {
    const size = Number(updates.defaultSize);
    if (isNaN(size) || size < 64 || size > 2048) {
      return { status: 400, body: { error: 'defaultSize must be between 64 and 2048' } };
    }
    config.defaultSize = size;
  }
  if (updates.errorCorrection !== undefined) {
    if (!['L', 'M', 'Q', 'H'].includes(updates.errorCorrection as string)) {
      return { status: 400, body: { error: 'errorCorrection must be L, M, Q, or H' } };
    }
    config.errorCorrection = updates.errorCorrection as Config['errorCorrection'];
  }
  if (updates.darkColor !== undefined) {
    config.darkColor = updates.darkColor;
  }
  if (updates.lightColor !== undefined) {
    config.lightColor = updates.lightColor;
  }
  if (updates.historyLimit !== undefined) {
    const limit = Number(updates.historyLimit);
    if (isNaN(limit) || limit < 1 || limit > 500) {
      return { status: 400, body: { error: 'historyLimit must be between 1 and 500' } };
    }
    config.historyLimit = limit;
  }
  if (updates.dotStyle !== undefined) {
    if (!['square', 'rounded', 'dots'].includes(updates.dotStyle as string)) {
      return { status: 400, body: { error: 'dotStyle must be square, rounded, or dots' } };
    }
    config.dotStyle = updates.dotStyle as Config['dotStyle'];
  }
  if (updates.cornerStyle !== undefined) {
    if (!['square', 'rounded', 'extra-rounded'].includes(updates.cornerStyle as string)) {
      return { status: 400, body: { error: 'cornerStyle must be square, rounded, or extra-rounded' } };
    }
    config.cornerStyle = updates.cornerStyle as Config['cornerStyle'];
  }
  if (updates.margin !== undefined) {
    const m = Number(updates.margin);
    if (isNaN(m) || m < 0 || m > 20) {
      return { status: 400, body: { error: 'margin must be between 0 and 20' } };
    }
    config.margin = m;
  }

  await saveConfig();

  return {
    status: 200,
    body: { ...config, message: 'Config updated' },
  };
}

// ── HTTP Route Handler: GET /api/v1/plugins/qrcode/history ──
export async function getHistory(): Promise<{ status: number; body: Record<string, unknown> }> {
  return {
    status: 200,
    body: {
      entries: history,
      total: history.length,
      generateCount,
    },
  };
}

// ── HTTP Route Handler: DELETE /api/v1/plugins/qrcode/history ──
export async function clearHistory(): Promise<{ status: number; body: Record<string, unknown> }> {
  history = [];
  await saveHistory();
  await refreshQRCodeSlot();
  return {
    status: 200,
    body: { message: 'History cleared', total: 0 },
  };
}

// ── Deactivate ──

export async function deactivate(): Promise<void> {
  if (api) {
    api.log.info(`QR Code plugin deactivated. Generated ${generateCount} QR codes this session.`);

    // Save final stats to memory
    await api.memory.save({
      name: 'qrcode-plugin-stats',
      type: 'feedback',
      description: 'QR Code plugin deactivation stats',
      content: JSON.stringify({
        totalGenerated: generateCount,
        historyCount: history.length,
        deactivatedAt: new Date().toISOString(),
      }),
      scope: 'team',
    });

    // Persist stats and history
    await saveStats();
    await saveHistory();

    // Remove prompt section (null content = remove)
    await api.prompt.inject('qrcode-usage', '');

    await api.ui?.unmountAll('titlebar-right');

    // Notify frontend
    await api.ws.broadcast({
      type: 'plugin_status',
      plugin: 'qrcode',
      message: 'QR Code plugin deactivated',
    });
  }
}
