// ── Memory v2: Hybrid SQLite + Vector + BM25 Architecture ──────────────────
// Phase 1 type definitions. Additive — does not change existing MemoryEntry,
// MemoryScope, or MemoryType (those remain in src/server/core/memory/).

// ── Core document type for SQLite storage ─────────────────────────────

export interface MemoryDocument {
  /** Unique ID (UUID) */
  id: string;
  /** Full text content */
  content: string;
  /** Corresponds to MemoryType: 'user' | 'feedback' | 'project' | 'reference' */
  memoryType: string;
  /** Corresponds to MemoryScope: 'team' | 'agent' | 'session' */
  scope: string;
  /** Agent ID or session ID for scoped memory lookup */
  scopeId?: string;
  /** Arbitrary tags for filtering (e.g. ['critical', 'decision']) */
  tags: string[];
  /** Flexible key-value metadata */
  metadata: Record<string, string>;
  /** ISO8601 created */
  createdAt: string;
  /** ISO8601 updated */
  updatedAt: string;
}

// ── Vector embedding ──────────────────────────────────────────────────

export interface MemoryEmbedding {
  docId: string;
  /** Float32 vector, dimension depends on model (default 384) */
  vector: Float32Array | number[];
  model: string;
}

// ── BM25 index types ──────────────────────────────────────────────────

export interface MemoryBm25Term {
  term: string;
  docId: string;
  termFrequency: number;
  positions: number[];
}

export interface MemoryBm25Stats {
  docCount: number;
  avgDocLength: number;
}

// ── Store configuration ───────────────────────────────────────────────

export interface MemoryStoreConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Embedding model dimension */
  embeddingDim: number;
  /** BM25 parameters */
  bm25K1: number;
  bm25B: number;
  /** Max documents before eviction */
  maxDocuments: number;
  /** Auto-save debounce in ms */
  autoSaveIntervalMs: number;
}

// ── Search ────────────────────────────────────────────────────────────

export interface MemoryQuery {
  /** Natural-language or keyword query text */
  text: string;
  /** Optional scope/type filtering */
  filter?: {
    memoryType?: string;
    scope?: string;
    scopeId?: string;
    tags?: string[];
  };
  /** Result count */
  topK: number;
  /** BM25 weight in hybrid score (0-1) */
  bm25Weight: number;
  /** Vector weight in hybrid score (0-1) */
  vectorWeight: number;
}

export interface MemorySearchResult {
  document: MemoryDocument;
  /** Combined hybrid score */
  score: number;
  /** BM25 component */
  bm25Score: number;
  /** Cosine-similarity component */
  vectorScore: number;
}

export interface MemorySearchResponse {
  query: string;
  results: MemorySearchResult[];
  totalSearched: number;
  durationMs: number;
}

// ── Embedding model info ──────────────────────────────────────────────

export interface MemoryEmbeddingModel {
  name: string;        // e.g. 'all-MiniLM-L6-v2'
  dimension: number;
  loaded: boolean;
}

// ── BM25 tokenizer ────────────────────────────────────────────────────

export interface MemoryTokenizer {
  /** Tokenize text into terms for BM25 indexing */
  tokenize(text: string): string[];
}
