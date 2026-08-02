#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const sessionsRoot = path.resolve(
  rootIndex >= 0 && args[rootIndex + 1]
    ? args[rootIndex + 1]
    : path.join(process.cwd(), 'data', 'sessions'),
);
const requiredFields = [
  'sessionId',
  'parentSessionId',
  'level',
  'agentId',
  'type',
  'status',
  'title',
  'workspace',
  'createdAt',
  'lastActiveAt',
  'subSessionIds',
  'metadata',
];

function readJsonWithBackup(filePath) {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      return { value: JSON.parse(fs.readFileSync(candidate, 'utf8')), source: candidate };
    } catch {
      // Continue to the backup.
    }
  }
  return null;
}

function validateMeta(sessionId, meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'meta_not_object';
  const missing = requiredFields.filter((field) => !(field in meta));
  if (missing.length) return `missing_fields:${missing.join(',')}`;
  if (meta.sessionId !== sessionId) return 'session_id_directory_mismatch';
  if (!['Main', 'Sub'].includes(meta.type)) return 'invalid_type';
  if (!['Active', 'Idle', 'Archived'].includes(meta.status)) return 'invalid_status';
  if (!Number.isInteger(meta.level) || meta.level < 0) return 'invalid_level';
  if (!Array.isArray(meta.subSessionIds)) return 'invalid_subsession_ids';
  if (!meta.metadata || typeof meta.metadata !== 'object' || Array.isArray(meta.metadata)) {
    return 'invalid_metadata';
  }
  return null;
}

function activeHistoryDir(sessionDir) {
  const manifest = readJsonWithBackup(path.join(sessionDir, 'active-history.json'));
  if (
    manifest
    && manifest.value
    && typeof manifest.value.generation === 'string'
    && /^[a-zA-Z0-9_.-]+$/.test(manifest.value.generation)
  ) {
    return path.join(sessionDir, '.history', manifest.value.generation);
  }
  return sessionDir;
}

function inspectTranscript(sessionId, sessionDir) {
  const historyDir = activeHistoryDir(sessionDir);
  let entries = [];
  try {
    entries = fs.readdirSync(historyDir);
  } catch {
    return { eventCount: 0, repairableTail: false, error: 'history_directory_unreadable' };
  }
  const shards = entries
    .filter((name) => /^shard_\d+\.jsonl$/.test(name))
    .sort();
  let eventCount = 0;
  let repairableTail = false;
  for (let shardIndex = 0; shardIndex < shards.length; shardIndex += 1) {
    const shardPath = path.join(historyDir, shards[shardIndex]);
    const buffer = fs.readFileSync(shardPath);
    const text = buffer.toString('utf8');
    const finalShard = shardIndex === shards.length - 1;
    if (text && !text.endsWith('\n') && !finalShard) {
      return { eventCount, repairableTail, error: `unterminated_nonfinal_shard:${shards[shardIndex]}` };
    }
    const lines = text.split('\n');
    const completeLineCount = text.endsWith('\n') ? lines.length - 1 : lines.length - 1;
    for (let lineIndex = 0; lineIndex < completeLineCount; lineIndex += 1) {
      if (!lines[lineIndex].trim()) continue;
      try {
        const event = JSON.parse(lines[lineIndex]);
        if (event.sessionId !== sessionId || typeof event.uuid !== 'string') {
          return { eventCount, repairableTail, error: `invalid_event:${shards[shardIndex]}:${lineIndex + 1}` };
        }
        eventCount += 1;
      } catch {
        return { eventCount, repairableTail, error: `corrupt_committed_line:${shards[shardIndex]}:${lineIndex + 1}` };
      }
    }
    if (text && !text.endsWith('\n')) {
      const tail = lines[lines.length - 1];
      try {
        const event = JSON.parse(tail);
        if (event.sessionId !== sessionId || typeof event.uuid !== 'string') {
          repairableTail = true;
        } else {
          eventCount += 1;
          repairableTail = true;
        }
      } catch {
        repairableTail = true;
      }
    }
  }
  return { eventCount, repairableTail, error: null };
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: 'dry-run',
  sessionsRoot,
  valid: [],
  repairable: [],
  invalid: [],
  quarantineDirectories: [],
};

if (!fs.existsSync(sessionsRoot)) {
  report.error = 'sessions_root_not_found';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 2;
} else {
  const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  const metas = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '_quarantine') {
      report.quarantineDirectories = fs.readdirSync(path.join(sessionsRoot, entry.name))
        .filter((name) => name !== 'audit.jsonl');
      continue;
    }
    if (entry.name.startsWith('_')) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    const loaded = readJsonWithBackup(path.join(sessionDir, 'meta.json'));
    if (!loaded) {
      report.invalid.push({ sessionId: entry.name, reason: 'meta_unreadable' });
      continue;
    }
    const metaError = validateMeta(entry.name, loaded.value);
    if (metaError) {
      report.invalid.push({ sessionId: entry.name, reason: metaError, metaSource: loaded.source });
      continue;
    }
    metas.set(entry.name, loaded.value);
    const transcript = inspectTranscript(entry.name, sessionDir);
    if (transcript.error) {
      report.invalid.push({ sessionId: entry.name, reason: transcript.error, metaSource: loaded.source });
    } else if (transcript.repairableTail) {
      report.repairable.push({
        sessionId: entry.name,
        reason: 'final_shard_tail_requires_recovery',
        eventCount: transcript.eventCount,
        metaSource: loaded.source,
      });
    } else {
      report.valid.push({
        sessionId: entry.name,
        eventCount: transcript.eventCount,
        metaSource: loaded.source,
      });
    }
  }

  const graphErrors = new Map();
  for (const [sessionId, meta] of metas) {
    if (meta.type === 'Main' && meta.parentSessionId !== null) {
      graphErrors.set(sessionId, 'main_session_has_parent');
    } else if (meta.type === 'Sub' && (!meta.parentSessionId || !metas.has(meta.parentSessionId))) {
      graphErrors.set(sessionId, 'subsession_parent_missing');
    }
  }
  const resolving = new Set();
  const resolved = new Set();
  function validateParentChain(sessionId) {
    if (graphErrors.has(sessionId) || resolved.has(sessionId)) return;
    if (resolving.has(sessionId)) {
      graphErrors.set(sessionId, 'session_parent_cycle');
      return;
    }
    const meta = metas.get(sessionId);
    if (!meta) return;
    resolving.add(sessionId);
    if (meta.parentSessionId) validateParentChain(meta.parentSessionId);
    resolving.delete(sessionId);
    if (meta.parentSessionId && graphErrors.has(meta.parentSessionId)) {
      graphErrors.set(sessionId, 'invalid_parent_chain');
    } else {
      resolved.add(sessionId);
    }
  }
  for (const sessionId of metas.keys()) validateParentChain(sessionId);
  for (const [sessionId, reason] of graphErrors) {
    report.valid = report.valid.filter((entry) => entry.sessionId !== sessionId);
    report.repairable = report.repairable.filter((entry) => entry.sessionId !== sessionId);
    if (!report.invalid.some((entry) => entry.sessionId === sessionId)) {
      report.invalid.push({ sessionId, reason });
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.invalid.length) process.exitCode = 1;
}
