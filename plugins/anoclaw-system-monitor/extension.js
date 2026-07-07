import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';

const PLUGIN_ROUTE_BASE = '/api/v1/plugins/system-monitor';
const POWERSHELL_TIMEOUT_MS = 9000;
const PROCESS_CACHE_MS = 7000;
const HARDWARE_CACHE_MS = 30000;
const STORAGE_CACHE_MS = 12000;
const NETWORK_CACHE_MS = 5000;
const CLEANUP_CACHE_MS = 15000;
const APP_CACHE_MS = 20000;
const STARTUP_CACHE_MS = 12000;
const SERVICE_CACHE_MS = 12000;

let _api = null;
let _processCache = { at: 0, value: null };
let _hardwareCache = { at: 0, value: null };
let _storageCache = { at: 0, value: null };
let _networkCache = { at: 0, value: null };
let _cleanupCache = { at: 0, value: null };
let _appsCache = { at: 0, value: null };
let _startupCache = { at: 0, value: null };
let _servicesCache = { at: 0, value: null };
let _lastCpuSample = readCpuSample();

export async function activate(anoclaw) {
  _api = anoclaw;

  await anoclaw.routes.register([
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/snapshot`, handler: 'getSnapshot' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/processes`, handler: 'getProcessesRoute' },
    { method: 'POST', path: `${PLUGIN_ROUTE_BASE}/processes/:pid/terminate`, handler: 'terminateProcessRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/hardware`, handler: 'getHardwareRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/storage`, handler: 'getStorageRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/network`, handler: 'getNetworkRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/cleanup/targets`, handler: 'getCleanupTargetsRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/cleanup/scan`, handler: 'scanCleanupRoute' },
    { method: 'POST', path: `${PLUGIN_ROUTE_BASE}/cleanup/run`, handler: 'runCleanupRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/apps`, handler: 'getAppsRoute' },
    { method: 'POST', path: `${PLUGIN_ROUTE_BASE}/apps/:id/uninstall`, handler: 'uninstallAppRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/startup`, handler: 'getStartupRoute' },
    { method: 'POST', path: `${PLUGIN_ROUTE_BASE}/startup/toggle`, handler: 'toggleStartupRoute' },
    { method: 'GET', path: `${PLUGIN_ROUTE_BASE}/services`, handler: 'getServicesRoute' },
    { method: 'POST', path: `${PLUGIN_ROUTE_BASE}/services/:name/control`, handler: 'controlServiceRoute' },
  ]);

  await anoclaw.tools.register({
    name: 'systemMonitorSnapshot',
    description: 'Read a compact system health snapshot: CPU, memory, disks, network, hardware, and top processes.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {
        includeProcesses: { type: 'boolean', description: 'Whether to include top processes.', default: true },
        processLimit: { type: 'number', description: 'Maximum number of processes to include.', default: 12 },
      },
    },
  });

  await anoclaw.tools.register({
    name: 'systemMonitorCleanupScan',
    description: 'Scan safe cleanup targets and estimate reclaimable bytes. This only scans; it never deletes files.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {
        targetIds: { type: 'array', items: { type: 'string' }, description: 'Optional cleanup target ids.' },
      },
    },
  });

  await anoclaw.tools.register({
    name: 'systemMonitorApps',
    description: 'List installed desktop applications with publisher, version, size, and uninstall availability.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by app name or publisher.' },
        limit: { type: 'number', default: 80 },
      },
    },
  });

  await anoclaw.tools.register({
    name: 'systemMonitorStartup',
    description: 'List startup items with command, source, and enabled state. This only reads startup configuration.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {},
    },
  });

  await anoclaw.tools.register({
    name: 'systemMonitorServices',
    description: 'List Windows services with status and start type. This only reads service state.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by service name or display name.' },
        limit: { type: 'number', default: 80 },
      },
    },
  });

  await anoclaw.tools.register({
    name: 'systemMonitorProcesses',
    description: 'List local computer processes with CPU, memory, pid, threads, handles, and executable path when available.',
    category: 'System',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by process name, pid, or path.' },
        sort: { type: 'string', enum: ['cpu', 'memory', 'name', 'pid'], default: 'cpu' },
        limit: { type: 'number', default: 30 },
      },
    },
  });

  await mountSlotBadge(anoclaw, 'System', 'ready', 'ok', 'system-manager-status', 70);

  anoclaw.log.info('System Monitor activated');
}

export async function deactivate() {
  await _api?.ui?.unmountAll('titlebar-right');
}

export async function executeTool(name, params = {}) {
  if (name === 'systemMonitorSnapshot') {
    const snapshot = await buildSnapshot({
      includeProcesses: params.includeProcesses !== false,
      processLimit: clampNumber(params.processLimit, 1, 50, 12),
    });
    return JSON.stringify(snapshot, null, 2);
  }
  if (name === 'systemMonitorProcesses') {
    const processes = await listProcesses({
      query: String(params.query || ''),
      sort: String(params.sort || 'cpu'),
      limit: clampNumber(params.limit, 1, 200, 30),
    });
    return JSON.stringify(processes, null, 2);
  }
  if (name === 'systemMonitorCleanupScan') {
    const scan = await scanCleanupTargets(Array.isArray(params.targetIds) ? params.targetIds : []);
    return JSON.stringify(scan, null, 2);
  }
  if (name === 'systemMonitorApps') {
    const apps = await listApps({
      query: String(params.query || ''),
      limit: clampNumber(params.limit, 1, 300, 80),
    });
    return JSON.stringify(apps, null, 2);
  }
  if (name === 'systemMonitorStartup') {
    const startup = await listStartupItems();
    return JSON.stringify(startup, null, 2);
  }
  if (name === 'systemMonitorServices') {
    const services = await listServices({
      query: String(params.query || ''),
      limit: clampNumber(params.limit, 1, 300, 80),
    });
    return JSON.stringify(services, null, 2);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function getSnapshot({ query }) {
  const qs = new URLSearchParams(query || '');
  const includeProcesses = qs.get('processes') !== '0';
  const processLimit = clampNumber(Number(qs.get('limit')), 1, 80, 18);
  return ok(await buildSnapshot({ includeProcesses, processLimit }));
}

export async function getProcessesRoute({ query }) {
  const qs = new URLSearchParams(query || '');
  const result = await listProcesses({
    query: qs.get('q') || '',
    sort: qs.get('sort') || 'cpu',
    limit: clampNumber(Number(qs.get('limit')), 1, 300, 120),
  });
  return ok(result);
}

export async function getHardwareRoute() {
  return ok(await getHardware());
}

export async function getStorageRoute() {
  return ok(await getStorage());
}

export async function getNetworkRoute() {
  return ok(await getNetwork());
}

export async function getCleanupTargetsRoute() {
  return ok({ targets: getCleanupTargets().map(t => publicCleanupTarget(t)) });
}

export async function scanCleanupRoute({ query }) {
  const qs = new URLSearchParams(query || '');
  const targetIds = qs.get('targets') ? qs.get('targets').split(',').map(s => s.trim()).filter(Boolean) : [];
  return ok(await scanCleanupTargets(targetIds));
}

export async function runCleanupRoute({ body }) {
  const targetIds = Array.isArray(body?.targetIds) ? body.targetIds.map(String) : [];
  const confirm = body?.confirm === 'CLEAN';
  if (!confirm) return fail(400, 'Cleanup requires confirm="CLEAN".');
  return ok(await runCleanup(targetIds));
}

export async function getAppsRoute({ query }) {
  const qs = new URLSearchParams(query || '');
  return ok(await listApps({
    query: qs.get('q') || '',
    limit: clampNumber(Number(qs.get('limit')), 1, 500, 220),
  }));
}

export async function uninstallAppRoute({ params, body }) {
  const apps = await listApps({ limit: 1000, includeCommands: true });
  const app = apps.items.find(a => a.id === params.id);
  if (!app) return fail(404, 'Application not found.');
  if (!app.uninstallString) return fail(400, 'This application does not expose an uninstall command.');
  if (body?.confirmName !== app.name) return fail(400, 'Uninstall confirmation did not match the application name.');
  const launched = await launchUninstaller(app);
  return ok({ launched, app: safeApp(app), message: 'Uninstaller launched. Follow the Windows uninstaller prompts to continue.' });
}

export async function getStartupRoute() {
  return ok(await listStartupItems());
}

export async function toggleStartupRoute({ body }) {
  const id = String(body?.id || '');
  const enabled = Boolean(body?.enabled);
  const confirm = body?.confirm === 'STARTUP';
  if (!confirm) return fail(400, 'Startup changes require confirm="STARTUP".');
  try {
    const result = await setStartupEnabled(id, enabled);
    _startupCache = { at: 0, value: null };
    return ok(result);
  } catch (err) {
    return fail(500, `Failed to update startup item: ${err.message}`);
  }
}

export async function getServicesRoute({ query }) {
  const qs = new URLSearchParams(query || '');
  return ok(await listServices({
    query: qs.get('q') || '',
    limit: clampNumber(Number(qs.get('limit')), 1, 500, 160),
  }));
}

export async function controlServiceRoute({ params, body }) {
  const action = String(body?.action || '');
  const confirm = body?.confirm === 'SERVICE';
  if (!confirm) return fail(400, 'Service control requires confirm="SERVICE".');
  if (!['start', 'stop', 'restart'].includes(action)) return fail(400, 'Unsupported service action.');
  try {
    const result = await controlService(params.name, action);
    _servicesCache = { at: 0, value: null };
    return ok(result);
  } catch (err) {
    return fail(500, `Failed to ${action} service: ${err.message}`);
  }
}

export async function terminateProcessRoute({ params, body }) {
  const pid = Number(params.pid);
  if (!Number.isFinite(pid) || pid <= 0) return fail(400, 'Invalid PID.');
  const processes = await listProcesses({ limit: 1000 });
  const proc = processes.items.find(p => p.pid === pid);
  if (!proc) return fail(404, 'Process not found.');
  if (body?.confirmName !== proc.name) return fail(400, 'Process termination confirmation did not match the process name.');
  if (pid === process.pid || /anoclaw/i.test(proc.name)) return fail(400, 'Refusing to terminate the host application from this plugin.');
  try {
    if (process.platform === 'win32') {
      await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Stop-Process -Id ${pid} -Force`], 8000);
    } else {
      process.kill(pid, 'SIGTERM');
    }
    _processCache = { at: 0, value: null };
    return ok({ terminated: true, process: proc });
  } catch (err) {
    return fail(500, `Failed to terminate process: ${err.message}`);
  }
}

async function buildSnapshot(options = {}) {
  const [cpuUsage, hardware, storage, network] = await Promise.all([
    getCpuUsage(),
    getHardware(),
    getStorage(),
    getNetwork(),
  ]);

  const memory = getMemory();
  const overview = {
    host: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSec: os.uptime(),
    bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    nodePid: process.pid,
  };

  const health = buildHealth(cpuUsage, memory, storage);
  const snapshot = {
    refreshedAt: new Date().toISOString(),
    overview,
    cpu: {
      usagePercent: cpuUsage,
      model: os.cpus()[0]?.model || hardware.cpu?.[0]?.Name || 'Unknown CPU',
      logicalCores: os.cpus().length,
      physicalCores: Number(hardware.cpu?.[0]?.NumberOfCores || 0) || null,
      speedMHz: os.cpus()[0]?.speed || hardware.cpu?.[0]?.MaxClockSpeed || null,
    },
    memory,
    storage,
    network,
    hardware,
    health,
  };

  if (options.includeProcesses !== false) {
    snapshot.processes = await listProcesses({ sort: 'cpu', limit: options.processLimit || 18 });
  }

  return snapshot;
}

function buildHealth(cpuUsage, memory, storage) {
  const disks = storage.logicalDisks || [];
  const lowestDiskFree = disks.length
    ? Math.min(...disks.filter(d => d.sizeBytes > 0).map(d => d.freePercent ?? 100))
    : null;
  return {
    cpu: cpuUsage >= 90 ? 'critical' : cpuUsage >= 75 ? 'busy' : 'normal',
    memory: memory.usedPercent >= 90 ? 'critical' : memory.usedPercent >= 78 ? 'busy' : 'normal',
    storage: lowestDiskFree !== null && lowestDiskFree <= 8 ? 'critical' : lowestDiskFree !== null && lowestDiskFree <= 16 ? 'busy' : 'normal',
    summary: [
      cpuUsage >= 75 ? 'High CPU activity' : 'CPU steady',
      memory.usedPercent >= 78 ? 'Memory pressure' : 'Memory steady',
      lowestDiskFree !== null && lowestDiskFree <= 16 ? 'Low disk space' : 'Storage steady',
    ],
  };
}

function getMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: percent(usedBytes, totalBytes),
  };
}

async function getCpuUsage() {
  const current = readCpuSample();
  const prev = _lastCpuSample;
  _lastCpuSample = current;
  if (!prev) return 0;
  const idle = current.idle - prev.idle;
  const total = current.total - prev.total;
  if (total <= 0) return 0;
  return round1(Math.max(0, Math.min(100, 100 - idle / total * 100)));
}

function readCpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, v) => sum + v, 0);
  }
  return { idle, total };
}

async function listProcesses(options = {}) {
  const cached = getFreshCache(_processCache, PROCESS_CACHE_MS);
  let processes = cached || await readProcesses();
  if (!cached) _processCache = { at: Date.now(), value: processes };

  const query = String(options.query || '').trim().toLowerCase();
  if (query) {
    processes = processes.filter(p =>
      String(p.name || '').toLowerCase().includes(query) ||
      String(p.pid || '').includes(query) ||
      String(p.path || '').toLowerCase().includes(query)
    );
  }

  const sort = String(options.sort || 'cpu');
  const sorted = [...processes].sort((a, b) => {
    if (sort === 'memory') return (b.memoryBytes || 0) - (a.memoryBytes || 0);
    if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
    if (sort === 'pid') return (a.pid || 0) - (b.pid || 0);
    const cpuB = b.cpuPercent || b.cpuSeconds || 0;
    const cpuA = a.cpuPercent || a.cpuSeconds || 0;
    return (cpuB - cpuA) || ((b.memoryBytes || 0) - (a.memoryBytes || 0));
  });

  return {
    refreshedAt: new Date().toISOString(),
    total: sorted.length,
    items: sorted.slice(0, clampNumber(options.limit, 1, 500, 120)),
  };
}

async function readProcesses() {
  if (process.platform === 'win32') {
    try {
      const script = `Get-Process | Select-Object -First 320 Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Depth 3`;
      const items = normalizeArray(await powershellJson(script, 15000)).map(normalizeProcess);
      if (items.length > 0) return items;
    } catch (err) {
      _api?.log.warn(`Process query failed: ${err.message}`);
    }
  }
  return fallbackProcesses();
}

function fallbackProcesses() {
  const current = process;
  return [{
    pid: current.pid,
    name: 'AnoClaw Worker',
    cpuPercent: 0,
    memoryBytes: current.memoryUsage().rss,
    threads: null,
    handles: null,
    parentPid: null,
    path: current.execPath,
    startedAt: null,
  }];
}

function normalizeProcess(p) {
  const cpuSeconds = nullableNumber(p.cpuSeconds ?? p.CPU);
  return {
    pid: Number(p.pid || p.ProcessId || p.IDProcess || p.Id || 0),
    name: String(p.name || p.Name || p.ProcessName || 'Unknown'),
    cpuPercent: round1(Number(p.cpuPercent || p.PercentProcessorTime || 0)),
    cpuSeconds,
    memoryBytes: Number(p.memoryBytes || p.WorkingSet || p.WorkingSet64 || 0),
    threads: nullableNumber(p.threads || p.ThreadCount),
    handles: nullableNumber(p.handles || p.HandleCount),
    parentPid: nullableNumber(p.parentPid || p.ParentProcessId),
    path: p.path || p.ExecutablePath || '',
    startedAt: p.startedAt || null,
  };
}

async function getHardware() {
  const cached = getFreshCache(_hardwareCache, HARDWARE_CACHE_MS);
  if (cached) return cached;

  const base = {
    cpu: [],
    computer: null,
    os: null,
    bios: null,
    baseboard: null,
    gpus: [],
    memoryModules: [],
    battery: [],
    temperature: [],
  };

  if (process.platform === 'win32') {
    try {
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$temperature = @()
try {
  $temperature = Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature |
    Select-Object InstanceName, @{Name='Celsius';Expression={[Math]::Round(($_.CurrentTemperature - 2732) / 10, 1)}}
} catch {}
[pscustomobject]@{
  cpu = @(Get-CimInstance Win32_Processor | Select-Object Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, CurrentClockSpeed, SocketDesignation, L2CacheSize, L3CacheSize)
  computer = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, SystemType, TotalPhysicalMemory, UserName, Domain
  os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime, InstallDate
  bios = Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SerialNumber
  baseboard = Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product, Version, SerialNumber
  gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion, VideoProcessor, CurrentHorizontalResolution, CurrentVerticalResolution)
  memoryModules = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Manufacturer, PartNumber, Capacity, Speed, ConfiguredClockSpeed, DeviceLocator, BankLabel)
  battery = @(Get-CimInstance Win32_Battery | Select-Object Name, EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime)
  temperature = @($temperature)
} | ConvertTo-Json -Depth 6
`;
      const data = { ...base, ...(await powershellJson(script) || {}) };
      data.cpu = normalizeArray(data.cpu);
      data.gpus = normalizeArray(data.gpus);
      data.memoryModules = normalizeArray(data.memoryModules);
      data.battery = normalizeArray(data.battery);
      data.temperature = normalizeArray(data.temperature);
      _hardwareCache = { at: Date.now(), value: data };
      return data;
    } catch (err) {
      _api?.log.warn(`Hardware query failed: ${err.message}`);
    }
  }

  const fallback = {
    ...base,
    cpu: os.cpus().slice(0, 1).map(c => ({ Name: c.model, MaxClockSpeed: c.speed })),
    computer: { Manufacturer: os.hostname(), Model: os.platform(), TotalPhysicalMemory: os.totalmem() },
    os: { Caption: `${os.type()} ${os.release()}`, OSArchitecture: os.arch(), LastBootUpTime: new Date(Date.now() - os.uptime() * 1000).toISOString() },
  };
  _hardwareCache = { at: Date.now(), value: fallback };
  return fallback;
}

async function getStorage() {
  const cached = getFreshCache(_storageCache, STORAGE_CACHE_MS);
  if (cached) return cached;

  const fallback = { logicalDisks: [], physicalDisks: [] };
  if (process.platform === 'win32') {
    try {
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$logical = [System.IO.DriveInfo]::GetDrives() |
  Where-Object { $_.IsReady } |
  Select-Object Name, DriveType, DriveFormat, TotalSize, AvailableFreeSpace, VolumeLabel
$physical = @()
try {
  $physical = Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, Size, BusType
} catch {}
[pscustomobject]@{
  logicalDisks = @($logical)
  physicalDisks = @($physical)
} | ConvertTo-Json -Depth 5
`;
      const data = await powershellJson(script) || fallback;
      data.logicalDisks = normalizeArray(data.logicalDisks).map(d => {
        const sizeBytes = Number(d.Size || d.TotalSize || 0);
        const freeBytes = Number(d.FreeSpace || d.AvailableFreeSpace || 0);
        const id = d.DeviceID || d.Name || '';
        return {
          id,
          name: d.VolumeName || d.VolumeLabel || id,
          fileSystem: d.FileSystem || d.DriveFormat || '',
          type: diskTypeName(Number(d.DriveType || 0)),
          sizeBytes,
          freeBytes,
          usedBytes: Math.max(0, sizeBytes - freeBytes),
          usedPercent: percent(sizeBytes - freeBytes, sizeBytes),
          freePercent: percent(freeBytes, sizeBytes),
        };
      });
      data.physicalDisks = normalizeArray(data.physicalDisks).map(d => ({
        name: d.FriendlyName || 'Disk',
        mediaType: d.MediaType || '',
        healthStatus: String(d.HealthStatus || ''),
        operationalStatus: Array.isArray(d.OperationalStatus) ? d.OperationalStatus.join(', ') : String(d.OperationalStatus || ''),
        sizeBytes: Number(d.Size || 0),
        busType: d.BusType || '',
      }));
      _storageCache = { at: Date.now(), value: data };
      return data;
    } catch (err) {
      _api?.log.warn(`Storage query failed: ${err.message}`);
    }
  }

  _storageCache = { at: Date.now(), value: fallback };
  return fallback;
}

async function getNetwork() {
  const cached = getFreshCache(_networkCache, NETWORK_CACHE_MS);
  if (cached) return cached;

  const nodeInterfaces = Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
    name,
    addresses: (addresses || []).filter(a => !a.internal).map(a => ({ address: a.address, family: a.family, mac: a.mac })),
  })).filter(n => n.addresses.length > 0);

  const fallback = {
    interfaces: nodeInterfaces,
    adapters: nodeInterfaces.map(i => ({
      name: i.name,
      description: i.addresses.map(a => `${a.family} ${a.address}`).join(', '),
      status: 'up',
      linkSpeed: '',
      macAddress: i.addresses[0]?.mac || '',
      receivedBytes: 0,
      sentBytes: 0,
    })),
  };
  if (process.platform === 'win32') {
    try {
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$adapters = @()
try {
  $adapters = Get-NetAdapter | ForEach-Object {
    $stats = Get-NetAdapterStatistics -Name $_.Name
    [pscustomobject]@{
      Name = $_.Name
      InterfaceDescription = $_.InterfaceDescription
      Status = $_.Status
      LinkSpeed = $_.LinkSpeed
      MacAddress = $_.MacAddress
      ReceivedBytes = $stats.ReceivedBytes
      SentBytes = $stats.SentBytes
    }
  }
} catch {}
[pscustomobject]@{ adapters = @($adapters) } | ConvertTo-Json -Depth 4
`;
      const data = await powershellJson(script) || {};
      const result = {
        interfaces: nodeInterfaces,
        adapters: normalizeArray(data.adapters).map(a => ({
          name: a.Name || '',
          description: a.InterfaceDescription || '',
          status: a.Status || '',
          linkSpeed: a.LinkSpeed || '',
          macAddress: a.MacAddress || '',
          receivedBytes: Number(a.ReceivedBytes || 0),
          sentBytes: Number(a.SentBytes || 0),
        })),
      };
      if (result.adapters.length === 0 && result.interfaces.length > 0) {
        result.adapters = result.interfaces.map(i => ({
          name: i.name,
          description: i.addresses.map(a => `${a.family} ${a.address}`).join(', '),
          status: 'up',
          linkSpeed: '',
          macAddress: i.addresses[0]?.mac || '',
          receivedBytes: 0,
          sentBytes: 0,
        }));
      }
      _networkCache = { at: Date.now(), value: result };
      return result;
    } catch (err) {
      _api?.log.warn(`Network query failed: ${err.message}`);
    }
  }

  _networkCache = { at: Date.now(), value: fallback };
  return fallback;
}

function getCleanupTargets() {
  const env = process.env;
  const local = env.LOCALAPPDATA || '';
  const roaming = env.APPDATA || '';
  const windir = env.WINDIR || 'C:\\Windows';
  const temp = env.TEMP || env.TMP || '';
  return [
    {
      id: 'user-temp',
      name: 'User temporary files',
      description: 'Temporary files created by apps in the current Windows user profile.',
      paths: [temp],
      olderThanMinutes: 15,
      removable: true,
    },
    {
      id: 'windows-temp',
      name: 'Windows temp files',
      description: 'System temporary files. Some files may require administrator permission.',
      paths: [path.join(windir, 'Temp')],
      olderThanMinutes: 60,
      removable: true,
    },
    {
      id: 'chrome-cache',
      name: 'Chrome cache',
      description: 'Chrome web cache and code cache. Open Chrome may keep some files locked.',
      paths: [
        path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
        path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'),
      ],
      olderThanMinutes: 30,
      removable: true,
    },
    {
      id: 'edge-cache',
      name: 'Edge cache',
      description: 'Microsoft Edge web cache and code cache.',
      paths: [
        path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
        path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'),
      ],
      olderThanMinutes: 30,
      removable: true,
    },
    {
      id: 'electron-cache',
      name: 'Electron app caches',
      description: 'Cache folders used by Electron apps under AppData.',
      paths: [
        path.join(roaming, 'Code', 'Cache'),
        path.join(roaming, 'Code', 'Code Cache'),
        path.join(roaming, 'Cursor', 'Cache'),
        path.join(roaming, 'Cursor', 'Code Cache'),
      ],
      olderThanMinutes: 60,
      removable: true,
    },
    {
      id: 'windows-logs',
      name: 'Windows logs',
      description: 'Common Windows log files. Locked files are skipped.',
      paths: [path.join(windir, 'Logs')],
      olderThanMinutes: 1440,
      removable: true,
      extensions: ['.log', '.etl', '.txt'],
    },
  ];
}

function publicCleanupTarget(target) {
  return {
    id: target.id,
    name: target.name,
    description: target.description,
    paths: target.paths.filter(Boolean),
    olderThanMinutes: target.olderThanMinutes,
    removable: target.removable,
  };
}

async function scanCleanupTargets(targetIds = []) {
  const key = targetIds.length ? targetIds.slice().sort().join(',') : '*';
  const cached = getFreshCache(_cleanupCache, CLEANUP_CACHE_MS);
  if (cached && cached.key === key) return cached.value;

  const selected = selectCleanupTargets(targetIds);
  const items = [];
  for (const target of selected) {
    const paths = [];
    let bytes = 0;
    let files = 0;
    let errors = 0;
    for (const root of target.paths.filter(Boolean)) {
      const result = await scanCleanupPath(root, target);
      paths.push(result);
      bytes += result.bytes;
      files += result.files;
      errors += result.errors;
    }
    items.push({
      ...publicCleanupTarget(target),
      bytes,
      files,
      errors,
      paths,
    });
  }
  const value = {
    scannedAt: new Date().toISOString(),
    totalBytes: items.reduce((sum, x) => sum + x.bytes, 0),
    totalFiles: items.reduce((sum, x) => sum + x.files, 0),
    items,
  };
  _cleanupCache = { at: Date.now(), value: { key, value } };
  return value;
}

async function runCleanup(targetIds = []) {
  const selected = selectCleanupTargets(targetIds).filter(t => t.removable);
  const items = [];
  for (const target of selected) {
    let deletedBytes = 0;
    let deletedFiles = 0;
    let skipped = 0;
    let errors = 0;
    for (const root of target.paths.filter(Boolean)) {
      const result = await cleanupPath(root, target);
      deletedBytes += result.deletedBytes;
      deletedFiles += result.deletedFiles;
      skipped += result.skipped;
      errors += result.errors;
    }
    items.push({
      id: target.id,
      name: target.name,
      deletedBytes,
      deletedFiles,
      skipped,
      errors,
    });
  }
  _cleanupCache = { at: 0, value: null };
  return {
    cleanedAt: new Date().toISOString(),
    totalDeletedBytes: items.reduce((sum, x) => sum + x.deletedBytes, 0),
    totalDeletedFiles: items.reduce((sum, x) => sum + x.deletedFiles, 0),
    items,
  };
}

function selectCleanupTargets(targetIds) {
  const targets = getCleanupTargets();
  if (!targetIds || targetIds.length === 0) return targets;
  const wanted = new Set(targetIds);
  return targets.filter(t => wanted.has(t.id));
}

async function scanCleanupPath(root, target) {
  const result = { root, exists: false, bytes: 0, files: 0, errors: 0 };
  if (!isSafeCleanupRoot(root)) return { ...result, errors: 1, error: 'Unsafe cleanup root' };
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return result;
    result.exists = true;
  } catch {
    return result;
  }

  const cutoff = Date.now() - (target.olderThanMinutes || 0) * 60_000;
  const stack = [{ dir: root, depth: 0 }];
  const maxDepth = 10;
  const maxFiles = 120000;
  while (stack.length && result.files < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      result.errors++;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      try {
        const stat = await fs.lstat(full);
        if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < maxDepth) {
          stack.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > cutoff) continue;
        if (target.extensions && !target.extensions.includes(path.extname(entry.name).toLowerCase())) continue;
        result.files++;
        result.bytes += stat.size || 0;
      } catch {
        result.errors++;
      }
    }
  }
  return result;
}

async function cleanupPath(root, target) {
  const result = { root, deletedBytes: 0, deletedFiles: 0, skipped: 0, errors: 0 };
  if (!isSafeCleanupRoot(root)) return { ...result, errors: 1 };
  const scan = await scanCleanupPath(root, target);
  if (!scan.exists) return result;

  const cutoff = Date.now() - (target.olderThanMinutes || 0) * 60_000;
  const dirs = [];
  const stack = [{ dir: root, depth: 0 }];
  const maxDepth = 10;
  const maxFiles = 120000;
  while (stack.length && result.deletedFiles + result.skipped < maxFiles) {
    const current = stack.pop();
    dirs.push(current.dir);
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      result.errors++;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      try {
        const stat = await fs.lstat(full);
        if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < maxDepth) {
          stack.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          result.skipped++;
          continue;
        }
        if (stat.mtimeMs > cutoff) {
          result.skipped++;
          continue;
        }
        if (target.extensions && !target.extensions.includes(path.extname(entry.name).toLowerCase())) {
          result.skipped++;
          continue;
        }
        await fs.rm(full, { force: true });
        result.deletedFiles++;
        result.deletedBytes += stat.size || 0;
      } catch {
        result.errors++;
      }
    }
  }

  for (const dir of dirs.reverse()) {
    if (dir === root) continue;
    try { await fs.rmdir(dir); } catch {}
  }
  return result;
}

function isSafeCleanupRoot(root) {
  if (!root || typeof root !== 'string') return false;
  const resolved = path.resolve(root);
  const lower = resolved.toLowerCase();
  if (resolved.length < 8) return false;
  if (/^[a-z]:\\?$/i.test(resolved)) return false;
  return (
    lower.includes('\\temp') ||
    lower.includes('\\cache') ||
    lower.includes('\\code cache') ||
    lower.includes('\\logs')
  );
}

async function listApps(options = {}) {
  const cached = getFreshCache(_appsCache, APP_CACHE_MS);
  let items = cached || await readInstalledApps();
  if (!cached) _appsCache = { at: Date.now(), value: items };

  const query = String(options.query || '').trim().toLowerCase();
  if (query) {
    items = items.filter(app =>
      app.name.toLowerCase().includes(query) ||
      String(app.publisher || '').toLowerCase().includes(query)
    );
  }
  items = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const limited = items.slice(0, clampNumber(options.limit, 1, 1000, 220));
  return {
    refreshedAt: new Date().toISOString(),
    total: items.length,
    items: options.includeCommands ? limited : limited.map(safeApp),
  };
}

async function readInstalledApps() {
  if (process.platform !== 'win32') return [];
  const script = `
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -and $_.SystemComponent -ne 1
  } | ForEach-Object {
    [pscustomobject]@{
      Name = $_.DisplayName
      Version = $_.DisplayVersion
      Publisher = $_.Publisher
      InstallDate = $_.InstallDate
      EstimatedSizeKB = $_.EstimatedSize
      InstallLocation = $_.InstallLocation
      UninstallString = $_.UninstallString
      QuietUninstallString = $_.QuietUninstallString
      WindowsInstaller = $_.WindowsInstaller
      RegistryKey = $_.PSChildName
      RegistryPath = $_.PSPath
    }
  }
}
$items | ConvertTo-Json -Depth 4
`;
  try {
    return normalizeArray(await powershellJson(script, 15000))
      .filter(x => x?.Name)
      .map(app => {
        const raw = {
          id: appId(app),
          name: String(app.Name),
          version: app.Version || '',
          publisher: app.Publisher || '',
          installDate: app.InstallDate || '',
          estimatedSizeBytes: Number(app.EstimatedSizeKB || 0) * 1024,
          installLocation: app.InstallLocation || '',
          uninstallString: app.UninstallString || '',
          quietUninstallString: app.QuietUninstallString || '',
          windowsInstaller: Boolean(Number(app.WindowsInstaller || 0)),
          registryKey: app.RegistryKey || '',
          registryPath: app.RegistryPath || '',
        };
        return raw;
      });
  } catch (err) {
    _api?.log.warn(`App list query failed: ${err.message}`);
    return [];
  }
}

function appId(app) {
  return createHash('sha1')
    .update([app.Name, app.Publisher, app.UninstallString, app.RegistryPath, app.RegistryKey].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function safeApp(app) {
  return {
    id: app.id,
    name: app.name,
    version: app.version,
    publisher: app.publisher,
    installDate: app.installDate,
    estimatedSizeBytes: app.estimatedSizeBytes,
    installLocation: app.installLocation,
    hasUninstall: Boolean(app.uninstallString),
    commandPreview: app.uninstallString || app.quietUninstallString || '',
    windowsInstaller: app.windowsInstaller,
  };
}

async function launchUninstaller(app) {
  const command = app.uninstallString || app.quietUninstallString;
  const guid = extractMsiGuid(command) || extractMsiGuid(app.registryKey);
  if (guid) {
    const child = spawn('msiexec.exe', ['/x', guid], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    return true;
  }
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" ${command}`], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.unref();
  return true;
}

function extractMsiGuid(value) {
  const match = String(value || '').match(/\{[0-9A-Fa-f-]{36}\}/);
  return match ? match[0] : null;
}

async function listStartupItems() {
  const cached = getFreshCache(_startupCache, STARTUP_CACHE_MS);
  if (cached) return cached;
  const disabled = await readDisabledStartup();
  let enabled = [];
  if (process.platform === 'win32') {
    const script = `
$defs = @(
  @{ Hive='HKCU'; Path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ Hive='HKLM'; Path='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }
)
$items = foreach ($d in $defs) {
  $props = Get-ItemProperty -Path $d.Path -ErrorAction SilentlyContinue
  if ($props) {
    $props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
      [pscustomobject]@{ Hive=$d.Hive; Path=$d.Path; Name=$_.Name; Command=[string]$_.Value; Enabled=$true; Type='registry' }
    }
  }
}
$items | ConvertTo-Json -Depth 4
`;
    try {
      enabled = normalizeArray(await powershellJson(script, 8000)).map(normalizeStartupItem);
    } catch (err) {
      _api?.log.warn(`Startup query failed: ${err.message}`);
    }
  }
  const disabledItems = Object.values(disabled).map(item => ({ ...item, enabled: false, disabled: true }));
  const value = {
    refreshedAt: new Date().toISOString(),
    items: [...enabled, ...disabledItems].sort((a, b) => a.name.localeCompare(b.name)),
  };
  _startupCache = { at: Date.now(), value };
  return value;
}

function normalizeStartupItem(item) {
  const normalized = {
    hive: item.Hive || item.hive || '',
    path: item.Path || item.path || '',
    name: item.Name || item.name || '',
    command: item.Command || item.command || '',
    enabled: item.Enabled !== false,
    type: item.Type || item.type || 'registry',
    manageable: true,
  };
  normalized.id = startupId(normalized);
  return normalized;
}

function startupId(item) {
  return createHash('sha1').update([item.hive, item.path, item.name].join('|')).digest('hex').slice(0, 16);
}

async function setStartupEnabled(id, enabled) {
  const disabled = await readDisabledStartup();
  if (enabled) {
    const item = disabled[id];
    if (!item) throw new Error('Disabled startup item was not found.');
    await setRegistryValue(item.path, item.name, item.command);
    delete disabled[id];
    await writeDisabledStartup(disabled);
    return { id, enabled: true, item };
  }

  const list = await listStartupItems();
  const item = list.items.find(x => x.id === id && x.enabled);
  if (!item) throw new Error('Enabled startup item was not found.');
  disabled[id] = { ...item, disabledAt: new Date().toISOString() };
  await writeDisabledStartup(disabled);
  await removeRegistryValue(item.path, item.name);
  return { id, enabled: false, item };
}

async function readDisabledStartup() {
  try {
    const file = await pluginDataFile('startup-disabled.json');
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeDisabledStartup(data) {
  const file = await pluginDataFile('startup-disabled.json');
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function pluginDataFile(name) {
  const dir = _api?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-system-monitor', 'data');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

async function setRegistryValue(regPath, name, value) {
  const script = `Set-ItemProperty -Path '${psEscape(regPath)}' -Name '${psEscape(name)}' -Value '${psEscape(value)}'`;
  await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 8000);
}

async function removeRegistryValue(regPath, name) {
  const script = `Remove-ItemProperty -Path '${psEscape(regPath)}' -Name '${psEscape(name)}' -ErrorAction Stop`;
  await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 8000);
}

async function listServices(options = {}) {
  const cached = getFreshCache(_servicesCache, SERVICE_CACHE_MS);
  let items = cached || await readServices();
  if (!cached) _servicesCache = { at: Date.now(), value: items };
  const query = String(options.query || '').trim().toLowerCase();
  if (query) {
    items = items.filter(s =>
      s.name.toLowerCase().includes(query) ||
      String(s.displayName || '').toLowerCase().includes(query)
    );
  }
  items = [...items].sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    refreshedAt: new Date().toISOString(),
    total: items.length,
    items: items.slice(0, clampNumber(options.limit, 1, 500, 160)),
  };
}

async function readServices() {
  if (process.platform !== 'win32') return [];
  const script = `Get-Service | Select-Object Name,DisplayName,Status,StartType,CanStop | ConvertTo-Json -Depth 3`;
  try {
    return normalizeArray(await powershellJson(script, 12000)).map(s => ({
      name: s.Name || '',
      displayName: s.DisplayName || s.Name || '',
      status: String(s.Status || ''),
      startType: String(s.StartType || ''),
      canStop: Boolean(s.CanStop),
    })).filter(s => s.name);
  } catch (err) {
    _api?.log.warn(`Service query failed: ${err.message}`);
    return [];
  }
}

async function controlService(name, action) {
  const safeName = psEscape(name);
  const command = action === 'start'
    ? `Start-Service -Name '${safeName}' -ErrorAction Stop`
    : action === 'stop'
      ? `Stop-Service -Name '${safeName}' -Force -ErrorAction Stop`
      : `Restart-Service -Name '${safeName}' -Force -ErrorAction Stop`;
  await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], 12000);
  return { name, action, ok: true };
}

function powershellJson(script, timeoutMs = POWERSHELL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      script,
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell query timed out'));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `PowerShell exited with ${code}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`Invalid PowerShell JSON: ${err.message}`));
      }
    });
  });
}

function runCommand(command, args = [], timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `${command} exited with ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function ok(body) {
  return { status: 200, body };
}

function fail(status, message) {
  return { status, body: { error: message, message } };
}

async function mountSlotBadge(anoclaw, label, value, tone, id, priority = 50) {
  const html = `<span class="anoclaw-slot-pill" data-tone="${tone}"><span class="slot-dot"></span><strong>${escapeAttr(label)}</strong><span>${escapeAttr(value)}</span></span>`;
  await anoclaw.ui?.mount('titlebar-right', html, { id, priority, position: 'append', replace: true });
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function psEscape(value) {
  return String(value || '').replace(/'/g, "''");
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getFreshCache(cache, maxAgeMs) {
  if (cache.value && Date.now() - cache.at < maxAgeMs) return cache.value;
  return null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function percent(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return round1(Math.max(0, Math.min(100, p / t * 100)));
}

function diskTypeName(type) {
  switch (type) {
    case 2: return 'removable';
    case 3: return 'local';
    case 4: return 'network';
    case 5: return 'optical';
    case 6: return 'ram';
    default: return 'unknown';
  }
}
