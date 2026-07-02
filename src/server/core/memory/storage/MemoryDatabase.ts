// MemoryDatabase.ts — SQLite persistence layer for memory v2 (Phase 1)
// Uses sql.js (pure WASM SQLite) with FTS5 for full-text search.
// Lazy initialization: database opened on first operation, not at import time.
//
// Tables: documents, documents_fts (FTS5), embeddings, bm25_terms, bm25_stats

import * as path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createLogger } from '../../logger.js';
import type {
  MemoryDocument,
  MemoryEmbedding,
  MemoryStoreConfig,
  MemoryBm25Stats,
} from '../../../../shared/types/memory.js';

// ---------------------------------------------------------------------------
// Standalone interfaces for sql.js (the npm package ships no .d.ts)
// ---------------------------------------------------------------------------

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
}

interface Database {
  run(sql: string, params?: BindParams): void;
  exec(sql: string, params?: BindParams): QueryResult[];
  prepare(sql: string): Statement;
  export(): Uint8Array;
  close(): void;
}

interface Statement {
  bind(params?: BindParams): boolean;
  step(): boolean;
  getAsObject(): Record<string, SqlValue>;
  get(): SqlValue[];
  free(): void;
}

interface QueryResult {
  columns: string[];
  values: SqlValue[][];
}

type BindParams = SqlValue[] | Record<string, SqlValue>;
type SqlValue = number | string | Uint8Array | null;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('anochat.memory.db');

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'memory.db');

const DEFAULT_CONFIG: MemoryStoreConfig = {
  dbPath: DEFAULT_DB_PATH,
  embeddingDim: 384,
  bm25K1: 1.5,
  bm25B: 0.75,
  maxDocuments: 10000,
  autoSaveIntervalMs: 5000,
};

// ---------------------------------------------------------------------------
// SQL DDL — idempotent CREATE TABLE IF NOT EXISTS
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'reference',
  scope TEXT NOT NULL DEFAULT 'agent',
  scope_id TEXT,
  category TEXT NOT NULL DEFAULT 'episodic',
  tags TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  access_count INTEGER DEFAULT 0,
  last_accessed_at TEXT,
  importance REAL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  memory_type,
  scope,
  tags,
  content='documents',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, content, memory_type, scope, tags)
  VALUES (new.rowid, new.content, new.memory_type, new.scope, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, memory_type, scope, tags)
  VALUES ('delete', old.rowid, old.content, old.memory_type, old.scope, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, memory_type, scope, tags)
  VALUES ('delete', old.rowid, old.content, old.memory_type, old.scope, old.tags);
  INSERT INTO documents_fts(rowid, content, memory_type, scope, tags)
  VALUES (new.rowid, new.content, new.memory_type, new.scope, new.tags);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bm25_terms (
  term TEXT NOT NULL,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  term_frequency INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (term, doc_id)
);

CREATE TABLE IF NOT EXISTS bm25_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc_count INTEGER NOT NULL DEFAULT 0,
  avg_doc_length REAL NOT NULL DEFAULT 0.0
);

INSERT OR IGNORE INTO bm25_stats (id, doc_count, avg_doc_length) VALUES (1, 0, 0.0);
`;

// ---------------------------------------------------------------------------
// MemoryDatabase
// ---------------------------------------------------------------------------

export class MemoryDatabase {
  private static _instance: MemoryDatabase | null = null;

  private _db: Database | null = null;
  private _SQL: SqlJsStatic | null = null;
  private _dbPath: string;
  private _config: MemoryStoreConfig;
  private _initPromise: Promise<void> | null = null;

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  static getInstance(config?: MemoryStoreConfig): MemoryDatabase {
    if (!this._instance) {
      this._instance = new MemoryDatabase(config);
    }
    return this._instance;
  }

  static resetInstance(): void {
    if (this._instance) {
      this._instance._closeSync();
      this._instance = null;
    }
  }

  private constructor(config?: MemoryStoreConfig) {
    this._config = config ?? DEFAULT_CONFIG;
    this._dbPath = path.resolve(this._config.dbPath);
  }

  // -----------------------------------------------------------------------
  // Initialization (lazy — first operation triggers init)
  // -----------------------------------------------------------------------

  /** Full path to the SQLite file on disk. */
  get dbPath(): string { return this._dbPath; }

  /** Whether the database is initialized and ready for queries. */
  get isReady(): boolean { return this._db !== null; }

  private async _init(): Promise<void> {
    if (this._db) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _doInit(): Promise<void> {
    // Ensure parent directory exists
    await mkdir(path.dirname(this._dbPath), { recursive: true });

    // Load existing database file or start fresh
    let fileBuffer: Uint8Array | null = null;
    try {
      const buf = await readFile(this._dbPath);
      fileBuffer = new Uint8Array(buf);
    } catch {
      // File doesn't exist — will create fresh
    }

    // Dynamic import of sql.js (CJS module, default export)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initSqlJsModule: any = await import('sql.js');
    const initFn: (config?: object) => Promise<SqlJsStatic> =
      initSqlJsModule.default || initSqlJsModule;
    this._SQL = await initFn();

    // Open or create the database
    this._db = fileBuffer
      ? new this._SQL.Database(fileBuffer)
      : new this._SQL.Database();

    // Run DDL (idempotent)
    this._db.run('PRAGMA journal_mode=WAL;');
    this._db.run('PRAGMA foreign_keys=ON;');
    this._db.run(DDL);

    // Persist if newly created
    if (!fileBuffer) {
      this._persist();
    }

    log.info('MemoryDatabase initialized', { dbPath: this._dbPath });
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /** Write the in-memory database to disk. Fire-and-forget after mutations. */
  private _persist(): void {
    if (!this._db) return;
    const data = Buffer.from(this._db.export());
    writeFile(this._dbPath, data).catch((err) => {
      log.error('MemoryDatabase persist failed', { error: (err as Error).message });
    });
  }

  // -----------------------------------------------------------------------
  // Document CRUD
  // -----------------------------------------------------------------------

  async insertDocument(doc: MemoryDocument): Promise<void> {
    await this._init();
    this._enforceMaxDocuments();
    const category = (doc as any).category || (doc as any).memoryCategory || 'episodic';
    this._db!.run(
      `INSERT INTO documents (id, content, memory_type, scope, scope_id, category, tags, metadata,
        access_count, last_accessed_at, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.id,
        doc.content,
        doc.memoryType,
        doc.scope,
        doc.scopeId ?? null,
        category,
        JSON.stringify(doc.tags ?? []),
        JSON.stringify(doc.metadata ?? {}),
        0,
        null,
        0.5,
        doc.createdAt || new Date().toISOString(),
        doc.updatedAt || new Date().toISOString(),
      ],
    );

    // Populate BM25 index: tokenize content and count term frequencies
    const terms = await tokenize(doc.content);
    const freq = new Map<string, number>();
    for (const t of terms) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    for (const [term, tf] of freq) {
      await this.upsertBm25Term(term, doc.id, tf);
    }

    this._persist();
  }

  async getDocument(id: string): Promise<MemoryDocument | null> {
    await this._init();
    const result = this._db!.exec('SELECT * FROM documents WHERE id = ?', [id]);
    if (!result.length || !result[0].values.length) return null;

    // Update access metadata
    this._db!.run(
      `UPDATE documents SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    );
    this._persist();

    return this._rowToDocument(result[0].columns, result[0].values[0]);
  }

  async updateDocument(id: string, updates: Partial<MemoryDocument>): Promise<void> {
    await this._init();
    const existing = await this.getDocument(id);
    if (!existing) return;

    // Read current importance from DB (not in MemoryDocument type)
    const impResult = this._db!.exec('SELECT importance FROM documents WHERE id = ?', [id]);
    const currentImportance =
      (impResult[0]?.values[0]?.[0] as number) ?? 0.5;

    const updatesRecord = updates as Record<string, unknown>;
    const importance =
      updatesRecord.importance !== undefined
        ? (updatesRecord.importance as number)
        : currentImportance;

    const merged: MemoryDocument = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    };

    this._db!.run(
      `UPDATE documents
         SET content = ?, memory_type = ?, scope = ?, scope_id = ?,
             tags = ?, metadata = ?, importance = ?, updated_at = ?
       WHERE id = ?`,
      [
        merged.content,
        merged.memoryType,
        merged.scope,
        merged.scopeId ?? null,
        JSON.stringify(merged.tags ?? []),
        JSON.stringify(merged.metadata ?? {}),
        importance,
        merged.updatedAt,
        id,
      ],
    );
    this._persist();
  }

  async deleteDocument(id: string): Promise<boolean> {
    await this._init();
    const before = this._db!.exec('SELECT COUNT(*) as c FROM documents WHERE id = ?', [id]);
    const count = before[0]?.values[0]?.[0] as number | undefined;
    if (!count) return false;

    this._db!.run('DELETE FROM documents WHERE id = ?', [id]);
    this._persist();
    return true;
  }

  async getAllDocuments(
    filter?: { scope?: string; memoryType?: string; scopeId?: string; category?: string },
  ): Promise<MemoryDocument[]> {
    await this._init();
    const clauses: string[] = [];
    const params: SqlValue[] = [];

    if (filter?.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter?.memoryType) {
      clauses.push('memory_type = ?');
      params.push(filter.memoryType);
    }
    if (filter?.scopeId) {
      clauses.push('scope_id = ?');
      params.push(filter.scopeId);
    }
    if (filter?.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = this._db!.exec(
      `SELECT * FROM documents ${where} ORDER BY updated_at DESC`,
      params,
    );
    if (!result.length) return [];

    return result[0].values.map((row) =>
      this._rowToDocument(result[0].columns, row),
    );
  }

  async documentCount(): Promise<number> {
    await this._init();
    const result = this._db!.exec('SELECT COUNT(*) as c FROM documents');
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  // -----------------------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------------------

  async upsertEmbedding(docId: string, vector: Float32Array, model: string): Promise<void> {
    await this._init();
    const buf = new Uint8Array(vector.buffer);
    this._db!.run(
      `INSERT OR REPLACE INTO embeddings (doc_id, vector, model, created_at)
       VALUES (?, ?, ?, ?)`,
      [docId, buf, model, new Date().toISOString()],
    );
    this._persist();
  }

  async getEmbedding(docId: string): Promise<MemoryEmbedding | null> {
    await this._init();
    const result = this._db!.exec(
      'SELECT doc_id, vector, model FROM embeddings WHERE doc_id = ?',
      [docId],
    );
    if (!result.length || !result[0].values.length) return null;

    const row = result[0].values[0];
    const colMap = this._columnMap(result[0].columns);
    const vectorBlob = row[colMap.vector] as Uint8Array;
    return {
      docId: row[colMap.doc_id] as string,
      vector: new Float32Array(vectorBlob.buffer),
      model: row[colMap.model] as string,
    };
  }

  async getAllEmbeddings(): Promise<MemoryEmbedding[]> {
    await this._init();
    const result = this._db!.exec('SELECT doc_id, vector, model FROM embeddings');
    if (!result.length) return [];

    const colMap = this._columnMap(result[0].columns);
    return result[0].values.map((row) => {
      const vectorBlob = row[colMap.vector] as Uint8Array;
      return {
        docId: row[colMap.doc_id] as string,
        vector: new Float32Array(vectorBlob.buffer),
        model: row[colMap.model] as string,
      };
    });
  }

  // -----------------------------------------------------------------------
  // BM25
  // -----------------------------------------------------------------------

  async upsertBm25Term(term: string, docId: string, tf: number): Promise<void> {
    await this._init();
    this._db!.run(
      `INSERT OR REPLACE INTO bm25_terms (term, doc_id, term_frequency)
       VALUES (?, ?, ?)`,
      [term, docId, tf],
    );
    this._persist();
  }

  async getBm25Stats(): Promise<MemoryBm25Stats> {
    await this._init();
    const result = this._db!.exec(
      'SELECT doc_count, avg_doc_length FROM bm25_stats WHERE id = 1',
    );
    if (!result.length || !result[0].values.length) {
      return { docCount: 0, avgDocLength: 0 };
    }
    const row = result[0].values[0];
    const colMap = this._columnMap(result[0].columns);
    return {
      docCount: row[colMap.doc_count] as number,
      avgDocLength: row[colMap.avg_doc_length] as number,
    };
  }

  async getTermFrequency(term: string, docId: string): Promise<number> {
    await this._init();
    const result = this._db!.exec(
      'SELECT term_frequency FROM bm25_terms WHERE term = ? AND doc_id = ?',
      [term, docId],
    );
    if (!result.length || !result[0].values.length) return 0;
    return (result[0].values[0][0] as number) ?? 0;
  }

  async getDocFrequency(term: string): Promise<number> {
    await this._init();
    const result = this._db!.exec(
      'SELECT COUNT(*) as c FROM bm25_terms WHERE term = ?',
      [term],
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  // -----------------------------------------------------------------------
  // FTS5 Search
  // -----------------------------------------------------------------------

  /**
   * Full-text search via FTS5. Returns matching document IDs ordered by BM25 rank.
   */
  async searchFts5(query: string, limit: number = 10): Promise<string[]> {
    await this._init();
    if (!query.trim()) return [];

    // Escape FTS5 special characters
    const escaped = this._escapeFts5Query(query);
    const sql =
      'SELECT d.id FROM documents_fts f JOIN documents d ON d.rowid = f.rowid WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?';
    const result = this._db!.exec(sql, [escaped, limit]);
    if (!result.length) return [];

    return result[0].values.map((row) => row[0] as string);
  }

  /** Escape special FTS5 characters for phrase matching. */
  private _escapeFts5Query(query: string): string {
    const safe = query
      .replace(/["*()^~@:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return '""';
    return safe
      .split(' ')
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(' AND ');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    if (this._db) {
      this._persist();
      // Wait a tick for the fire-and-forget persist to flush
      await new Promise((resolve) => setTimeout(resolve, 100));
      this._db.close();
      this._db = null;
      this._SQL = null;
      log.info('MemoryDatabase closed');
    }
  }

  /** Synchronous close for resetInstance — no await available. */
  private _closeSync(): void {
    if (this._db) {
      try {
        const data = Buffer.from(this._db.export());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fsSync = require('node:fs') as any;
        fsSync.writeFileSync(this._dbPath, data);
      } catch {
        // Best-effort
      }
      this._db.close();
      this._db = null;
      this._SQL = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Enforce maxDocuments by evicting oldest documents. */
  private _enforceMaxDocuments(): void {
    const cap = this._config.maxDocuments || DEFAULT_CONFIG.maxDocuments;
    const countResult = this._db!.exec('SELECT COUNT(*) as c FROM documents');
    const count = (countResult[0]?.values[0]?.[0] as number) ?? 0;
    if (count >= cap) {
      const toRemove = Math.max(1, Math.floor(cap * 0.1));
      this._db!.run(
        'DELETE FROM documents WHERE id IN (SELECT id FROM documents ORDER BY created_at ASC LIMIT ?)',
        [toRemove],
      );
    }
  }

  /** Build a column-name → index map from a result set's columns array. */
  private _columnMap(columns: string[]): Record<string, number> {
    const map: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      map[columns[i]] = i;
    }
    return map;
  }

  /** Convert a documents row (columns + values) to a MemoryDocument. */
  private _rowToDocument(columns: string[], row: SqlValue[]): MemoryDocument {
    const col = this._columnMap(columns);
    const tagsRaw = (row[col.tags] as string) || '[]';
    const metadataRaw = (row[col.metadata] as string) || '{}';
    const scopeIdRaw = row[col.scope_id];
    const categoryRaw = col.category !== undefined ? (row[col.category] as string) : undefined;
    const doc: any = {
      id: row[col.id] as string,
      content: row[col.content] as string,
      memoryType: (row[col.memory_type] as string) || 'reference',
      scope: (row[col.scope] as string) || 'agent',
      scopeId: (scopeIdRaw as string) || undefined,
      tags: JSON.parse(tagsRaw) as string[],
      metadata: JSON.parse(metadataRaw) as Record<string, string>,
      createdAt: row[col.created_at] as string,
      updatedAt: row[col.updated_at] as string,
    };
    if (categoryRaw) doc.category = categoryRaw;
    return doc as MemoryDocument;
  }
}

// ---------------------------------------------------------------------------
// Standalone tokenizer
// ---------------------------------------------------------------------------

/** Lazy-loaded jieba instance — shared across calls, loaded once. */
let _jiebaCache: { cut: (text: string, hmm?: boolean) => string[] } | null = null;
let _jiebaLoadAttempted = false;

/**
 * Tokenize text into lowercase terms for BM25 indexing.
 * Uses jieba-wasm for Chinese text when available.
 * Falls back to whitespace/punctuation splitting.
 * Filters tokens with length >= 2.
 */
export async function tokenize(text: string): Promise<string[]> {
  if (!text) return [];

  // Lazy-load jieba-wasm once
  if (!_jiebaLoadAttempted) {
    _jiebaLoadAttempted = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import('jieba-wasm');
      _jiebaCache = {
        cut: mod.cut || ((t: string) => t.split(/\s+/)),
      };
    } catch {
      // jieba-wasm unavailable — will use fallback
    }
  }

  let tokens: string[];
  if (_jiebaCache) {
    tokens = _jiebaCache.cut(text, true);
  } else {
    // Fallback: split on whitespace and punctuation
    tokens = text.split(/[\s\p{P}]+/u);
  }

  return tokens
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length >= 2);
}
