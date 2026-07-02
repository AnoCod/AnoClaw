# MemoryDatabase

SQLite persistence layer for AnoClaw memory v2. Uses
[sql.js](https://github.com/sql-js/sql.js/) (pure WASM SQLite) with FTS5
for full-text search and dedicated tables for vector embeddings and BM25 index.

## MemorySynonyms — Cross-language query expansion

Memory search supports cross-language queries through `MemorySynonyms.ts`. When a user
searches in Chinese (e.g. "日志"), the query is automatically expanded to include
English equivalents, so the search matches English content as well.

### How it works

1. **Jieba tokenization**: The query is first tokenized using
   [jieba-wasm](https://github.com/valdemarceccon/jieba-wasm), a WASM port of
   the Jieba Chinese text segmentation library. This correctly handles
   multi-character compound words like "配置", "数据库", and "工作流" that a
   simple whitespace split would miss.

2. **Synonym lookup**: Each token is looked up in the static synonym map
   defined in `MemorySynonyms.ts`. The map contains Chinese-to-English and
   English-to-related-term entries.

3. **CJK safety**: English-only queries never get CJK characters in their
   expansion. This prevents Fuse.js from failing on mixed-script content.

### Example

```
Query:  "日志"
  -> Jieba tokenizes:  ["日志"]
  -> Lookup "日志":    ["log", "logging", "journal"]
  -> Expanded:         "日志 log logging journal"

Query:  "日志配置nginx"
  -> Jieba tokenizes:  ["日志", "配置", "nginx"]
  -> Lookup "日志":    ["log", "logging", "journal"]
  -> Lookup "配置":    ["config", "settings", "configuration"]
  -> Lookup "nginx":   (no match)
  -> Expanded:         "日志配置nginx log logging journal config settings configuration"
```

### Fallback

If `jieba-wasm` is unavailable, the expander falls back to a simple
whitespace/punctuation split. This works for space-separated tokens but may
miss compound Chinese words.

The synonym map is defined in `src/server/core/memory/MemorySynonyms.ts`.
The dynamic Jieba import pattern follows `MemoryDatabase.tokenize()` — the
module is loaded once on first use and cached for all subsequent calls.

## Features

- **Lazy initialization** — database opens on first operation, not at import time.
- **Idempotent DDL** — all `CREATE TABLE IF NOT EXISTS`, safe to call repeatedly.
- **FTS5 full-text search** with automatic triggers on `documents` table.
- **BM25 term index** — separate `bm25_terms` table for ranking.
- **Embedding storage** — raw Float32 blob storage for vector search.
- **Document cap** — max 10,000 documents, oldest 10% evicted on overflow.
- **Singleton** — `getInstance()` / `resetInstance()` pattern.

## Schema

| Table | Purpose |
|---|---|
| `documents` | Core document store — content, type, scope, tags, metadata, access stats |
| `documents_fts` | FTS5 virtual table, auto-synced via triggers |
| `embeddings` | Float32 vector blobs, one per document |
| `bm25_terms` | Per-term frequency per document |
| `bm25_stats` | Global BM25 statistics (doc count, avg length) |

Default database path: `data/memory.db`

## Public API

### `MemoryDatabase.getInstance(config?: MemoryStoreConfig)`

Returns the singleton. Optional config for custom paths and BM25 parameters.

### Document CRUD

#### `insertDocument(doc: MemoryDocument): Promise<void>`

Insert a new document. Automatically enforces the max-document cap and persists.

```ts
await db.insertDocument({
  id: 'doc-001',
  content: 'How to configure logging',
  memoryType: 'reference',
  scope: 'agent',
  scopeId: 'agent-42',
  tags: ['logging', 'config'],
  metadata: { source: 'chat' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

#### `getDocument(id: string): Promise<MemoryDocument | null>`

Fetch a single document by ID. Updates `access_count` and `last_accessed_at`.

#### `updateDocument(id: string, updates: Partial<MemoryDocument>): Promise<void>`

Partial update. Merges provided fields with existing document. Sets `updatedAt`
to current time.

#### `deleteDocument(id: string): Promise<boolean>`

Delete by ID. Returns `true` if the document existed and was deleted.

#### `getAllDocuments(filter?): Promise<MemoryDocument[]>`

List all documents, optionally filtered by `scope`, `memoryType`, and `scopeId`.
Ordered by `updated_at DESC`.

```ts
const docs = await db.getAllDocuments({ scope: 'agent', scopeId: 'agent-42' });
```

#### `documentCount(): Promise<number>`

Returns total document count.

### Embedding CRUD

#### `upsertEmbedding(docId: string, vector: Float32Array, model: string): Promise<void>`

Insert or replace an embedding vector. `vector` must be a `Float32Array`.

#### `getEmbedding(docId: string): Promise<MemoryEmbedding | null>`

Fetch embedding by document ID. Returns `{ docId, vector, model }` or `null`.

#### `getAllEmbeddings(): Promise<MemoryEmbedding[]>`

Fetch all embeddings. Used for batch vector search.

### BM25 methods

#### `upsertBm25Term(term: string, docId: string, tf: number): Promise<void>`

Insert or update a term's frequency for a document.

#### `getBm25Stats(): Promise<MemoryBm25Stats>`

Returns `{ docCount, avgDocLength }` for BM25 scoring.

#### `getTermFrequency(term: string, docId: string): Promise<number>`

Get the term frequency of a term in a specific document.

#### `getDocFrequency(term: string): Promise<number>`

Get the number of documents containing a given term.

### FTS5 search

#### `searchFts5(query: string, limit?: number): Promise<string[]>`

Full-text search via FTS5. Returns matching document IDs ordered by BM25 rank.
Special FTS5 characters are escaped automatically. Default limit is 10.

```ts
const ids = await db.searchFts5('logging configuration', 20);
```

### Lifecycle

#### `close(): Promise<void>`

Persist and close the database. Flushes WAL before closing.

### Standalone tokenizer

#### `tokenize(text: string): Promise<string[]>`

Tokenize text for BM25 indexing. Uses jieba-wasm for Chinese text when available.
Falls back to whitespace/punctuation splitting. Filters tokens with length >= 2.

```ts
import { tokenize } from './storage/MemoryDatabase.js';

const terms = await tokenize('Hello world 你好世界');
// ['hello', 'world', '你好', '世界']
```

## Usage example

```ts
import { MemoryDatabase, tokenize } from './storage/MemoryDatabase.js';
import { EmbeddingService } from './embedding/EmbeddingService.js';

async function indexDocument(id: string, content: string) {
  const db = MemoryDatabase.getInstance();
  const es = EmbeddingService.getInstance();

  // 1. Insert document
  await db.insertDocument({
    id,
    content,
    memoryType: 'reference',
    scope: 'agent',
    scopeId: 'agent-42',
    tags: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 2. Populate BM25 terms
  const terms = await tokenize(content);
  const freq = new Map<string, number>();
  for (const t of terms) freq.set(t, (freq.get(t) || 0) + 1);
  for (const [term, tf] of freq) {
    await db.upsertBm25Term(term, id, tf);
  }

  // 3. Generate and store embedding
  const vector = await es.embed(content);
  await db.upsertEmbedding(id, vector, 'all-MiniLM-L6-v2');
}

async function searchMemory(query: string) {
  const db = MemoryDatabase.getInstance();

  // FTS5 search
  const ids = await db.searchFts5(query, 10);

  // Fetch full documents
  const docs = [];
  for (const id of ids) {
    const doc = await db.getDocument(id);
    if (doc) docs.push(doc);
  }
  return docs;
}
```
