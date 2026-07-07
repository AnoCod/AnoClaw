import path from 'node:path';
import { promises as fs } from 'node:fs';

const TOOL_ORGANIZE_FILES = 'files.organize';

let api = null;

export async function activate(anoclaw) {
  api = anoclaw;

  await anoclaw.tools.register({
    name: TOOL_ORGANIZE_FILES,
    description: 'Scan a local folder, classify files, optionally move them into category folders, and create a markdown organization report artifact.',
    category: 'Files',
    parametersSchema: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Folder to organize. Defaults to the current workspace.' },
        targetRoot: { type: 'string', description: 'Destination root for category folders. Defaults to folderPath.' },
        strategy: { type: 'string', enum: ['byType'], description: 'Organization strategy. Default: byType.' },
        apply: { type: 'boolean', description: 'Move files when true. Default false creates a plan only.' },
        recursive: { type: 'boolean', description: 'Scan nested folders. Default false.' },
        includeHidden: { type: 'boolean', description: 'Include hidden dotfiles. Default false.' },
        maxFiles: { type: 'number', description: 'Maximum files to scan. Default 500.' },
      },
    },
  });

  anoclaw.log.info('Files plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  if (toolName !== TOOL_ORGANIZE_FILES) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const result = await createFileOrganizationArtifact(params, ctx, api);
  return JSON.stringify(result, null, 2);
}

export async function createFileOrganizationArtifact(params = {}, ctx = null, anoclaw = api) {
  const sourceRoot = resolveInputPath(optionalText(params.folderPath || params.path || params.directory) || optionalText(ctx?.workspace) || process.cwd(), ctx);
  const targetRoot = resolveTargetRoot(params.targetRoot, sourceRoot, ctx);
  const strategy = optionalText(params.strategy) || 'byType';
  if (strategy !== 'byType') throw new Error(`Unsupported organization strategy: ${strategy}`);

  const sourceStat = await fs.stat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new Error(`folderPath is not a directory: ${sourceRoot}`);
  await fs.mkdir(targetRoot, { recursive: true });

  const options = {
    apply: params.apply === true,
    recursive: params.recursive === true,
    includeHidden: params.includeHidden === true,
    maxFiles: clampNumber(params.maxFiles, 1, 5000, 500),
  };
  const files = await scanFolder(sourceRoot, options);
  const plan = await buildOrganizationPlan(files, { sourceRoot, targetRoot });
  const result = options.apply ? await applyOrganizationPlan(plan) : markPlanOnly(plan);
  const summary = summarizePlan(result);

  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-files', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });
  const reportTitle = optionalText(params.title) || (options.apply ? 'File organization report' : 'File organization plan');
  const reportPath = path.join(outputDir, `${safeSegment(reportTitle).slice(0, 60) || 'file-organization'}-${Date.now().toString(36)}.md`);
  const markdown = fileOrganizationToMarkdown({
    title: reportTitle,
    sourceRoot,
    targetRoot,
    strategy,
    options,
    result,
    summary,
  });
  await fs.writeFile(reportPath, markdown, 'utf8');
  const reportStat = await fs.stat(reportPath);

  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title: reportTitle,
      kind: 'automation_result',
      status: 'done',
      capabilityId: 'files.organize',
      description: options.apply ? 'Folder organization changes were applied.' : 'Folder organization plan was generated.',
      files: [{
        path: reportPath,
        label: 'Organization report',
        mimeType: 'text/markdown',
        sizeBytes: reportStat.size,
        role: 'primary',
      }],
      preview: {
        type: 'markdown',
        content: markdown,
        mimeType: 'text/markdown',
      },
      metadata: {
        sourceRoot,
        targetRoot,
        strategy,
        applied: options.apply,
        scannedFiles: files.length,
        plannedMoves: summary.plannedMoves,
        movedFiles: summary.movedFiles,
        skippedFiles: summary.skippedFiles,
        plugin: 'anoclaw-files',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    applied: options.apply,
    filePath: reportPath,
    artifactId: artifact?.id,
    artifact,
    preview: markdown,
    sourceRoot,
    targetRoot,
    scannedFiles: files.length,
    plannedMoves: summary.plannedMoves,
    movedFiles: summary.movedFiles,
    skippedFiles: summary.skippedFiles,
    errors: summary.errors,
    actions: result.map(publicAction),
  };
}

async function scanFolder(root, options) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files.length < options.maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= options.maxFiles) break;
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive && !SKIPPED_DIRS.has(entry.name.toLowerCase())) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      files.push({
        path: fullPath,
        name: entry.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function buildOrganizationPlan(files, { sourceRoot, targetRoot }) {
  const usedDestinations = new Set();
  const actions = [];
  for (const file of files) {
    const category = categoryForFile(file.name);
    const rawDestination = path.join(targetRoot, category, file.name);
    const samePath = path.resolve(file.path).toLowerCase() === path.resolve(rawDestination).toLowerCase();
    const destination = samePath ? file.path : await uniqueDestination(rawDestination, usedDestinations);
    actions.push({
      sourcePath: file.path,
      relativePath: path.relative(sourceRoot, file.path),
      destinationPath: samePath ? file.path : destination,
      destinationRelativePath: path.relative(targetRoot, samePath ? file.path : destination),
      category,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      status: samePath ? 'skipped' : 'planned',
      reason: samePath ? 'already organized' : '',
    });
  }
  return actions;
}

function markPlanOnly(actions) {
  return actions.map((action) => ({ ...action, status: action.status === 'planned' ? 'planned' : action.status }));
}

async function applyOrganizationPlan(actions) {
  const results = [];
  for (const action of actions) {
    if (action.status === 'skipped') {
      results.push(action);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(action.destinationPath), { recursive: true });
      await fs.rename(action.sourcePath, action.destinationPath);
      results.push({ ...action, status: 'moved' });
    } catch (error) {
      results.push({
        ...action,
        status: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function uniqueDestination(destination, usedDestinations) {
  const parsed = path.parse(destination);
  let candidate = destination;
  let index = 1;
  while (usedDestinations.has(candidate.toLowerCase()) || await pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  usedDestinations.add(candidate.toLowerCase());
  return candidate;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizePlan(actions) {
  return {
    plannedMoves: actions.filter((action) => action.status === 'planned' || action.status === 'moved').length,
    movedFiles: actions.filter((action) => action.status === 'moved').length,
    skippedFiles: actions.filter((action) => action.status === 'skipped').length,
    errors: actions.filter((action) => action.status === 'error').length,
    totalBytes: actions.reduce((total, action) => total + (action.sizeBytes || 0), 0),
  };
}

function fileOrganizationToMarkdown({ title, sourceRoot, targetRoot, strategy, options, result, summary }) {
  const lines = [
    `# ${title}`,
    '',
    `- Source: ${sourceRoot}`,
    `- Target: ${targetRoot}`,
    `- Strategy: ${strategy}`,
    `- Mode: ${options.apply ? 'applied' : 'plan only'}`,
    `- Recursive: ${options.recursive ? 'yes' : 'no'}`,
    `- Files scanned: ${result.length}`,
    `- Planned moves: ${summary.plannedMoves}`,
    `- Moved files: ${summary.movedFiles}`,
    `- Skipped files: ${summary.skippedFiles}`,
    `- Errors: ${summary.errors}`,
    '',
    '## Actions',
    '',
    '| File | Category | Destination | Status |',
    '| --- | --- | --- | --- |',
  ];
  for (const action of result.slice(0, 300)) {
    lines.push(`| ${escapeMarkdown(displayPath(action.relativePath))} | ${escapeMarkdown(action.category)} | ${escapeMarkdown(displayPath(action.destinationRelativePath))} | ${escapeMarkdown(action.status)} |`);
  }
  if (result.length > 300) {
    lines.push(`| ... | ... | ${result.length - 300} more actions omitted | ... |`);
  }
  return lines.join('\n').trim();
}

function publicAction(action) {
  return {
    sourcePath: action.sourcePath,
    destinationPath: action.destinationPath,
    category: action.category,
    status: action.status,
    reason: action.reason,
  };
}

function categoryForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.pdf'].includes(ext)) return 'PDFs';
  if (['.doc', '.docx', '.txt', '.md', '.rtf', '.odt'].includes(ext)) return 'Documents';
  if (['.ppt', '.pptx', '.key'].includes(ext)) return 'Presentations';
  if (['.xls', '.xlsx', '.csv', '.tsv', '.ods'].includes(ext)) return 'Spreadsheets';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic'].includes(ext)) return 'Images';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv'].includes(ext)) return 'Videos';
  if (['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'].includes(ext)) return 'Audio';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) return 'Archives';
  if (['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.go', '.rs', '.php', '.rb', '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.sql', '.sh', '.ps1'].includes(ext)) return 'Code';
  if (['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm'].includes(ext)) return 'Installers';
  return 'Other';
}

function resolveInputPath(inputPath, ctx) {
  if (path.isAbsolute(inputPath)) return inputPath;
  const base = optionalText(ctx?.workspace) || process.cwd();
  return path.resolve(base, inputPath);
}

function resolveTargetRoot(targetRoot, sourceRoot, ctx) {
  const value = optionalText(targetRoot);
  if (!value) return sourceRoot;
  if (path.isAbsolute(value)) return value;
  const base = optionalText(ctx?.workspace) || sourceRoot;
  return path.resolve(base, value);
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function displayPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

const SKIPPED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'release',
  'coverage',
  '.codex',
]);
