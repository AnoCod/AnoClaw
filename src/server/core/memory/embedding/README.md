# EmbeddingService

ONNX-based text embedding for the AnoClaw memory system. Uses the
`all-MiniLM-L6-v2` model to produce 384-dimensional sentence embeddings.

## Features

- **Lazy initialization** — model loads on first `embed()` call, not at import time.
- **Graceful fallback** — if ONNX or model files are unavailable, returns zero vectors
  (384 zeros). Memory degrades to keyword-only search but never crashes.
- **Singleton** — `getInstance()` / `resetInstance()` pattern.
- **Static cosine similarity** — no model needed for comparison.

## Model files

Expected at runtime:

```
data/models/all-MiniLM-L6-v2/model.onnx
data/models/all-MiniLM-L6-v2/tokenizer.json
```

If either file is missing the service enters fallback mode and logs a warning.

## Public API

### `EmbeddingService.getInstance()`

Returns the singleton instance.

### `embed(text: string): Promise<Float32Array>`

Embed a single string. Returns a `Float32Array` of 384 floats (L2-normalized).
If the model is not ready or `text` is empty, returns a zero vector.

```ts
const es = EmbeddingService.getInstance();
const vec = await es.embed("Hello world");
// vec is Float32Array(384)
```

### `embedBatch(texts: string[]): Promise<Float32Array[]>`

Embed multiple strings. Each element is independent — a failure for one text
returns a zero vector for that text only (does not fail the batch).

```ts
const vecs = await es.embedBatch(["first text", "second text"]);
// vecs.length === 2, each Float32Array(384)
```

### `isReady(): boolean`

Returns `true` when the ONNX model and tokenizer are both loaded in memory.

```ts
if (es.isReady()) {
  // safe to call embed()
}
```

### `getModelInfo(): MemoryEmbeddingModel`

Returns model metadata:

```ts
const info = es.getModelInfo();
// { name: 'all-MiniLM-L6-v2', dimension: 384, loaded: true | false }
```

### `EmbeddingService.cosineSimilarity(a, b): number`

Static method. Computes cosine similarity between two vectors. Handles zero vectors
by returning 0. Accepts `Float32Array` or `number[]`.

```ts
const sim = EmbeddingService.cosineSimilarity(vecA, vecB);
// 0.0 to 1.0
```

### `dispose(): void`

Releases the ONNX inference session. After calling `dispose()`, the instance is
unusable — call `resetInstance()` to get a fresh one.

### `EmbeddingService.resetInstance()`

Static. Disposes the current instance and clears the singleton.

## Internal pipeline

```
text → WordPieceTokenizer.encode() → inputIds + attentionMask
     → onnxruntime InferenceSession.run() → hidden states
     → mean-pool (weighted by attention mask) → L2-normalize
     → Float32Array(384)
```

## Usage example

```ts
import { EmbeddingService } from './embedding/EmbeddingService.js';
import { MemoryDatabase } from './storage/MemoryDatabase.js';

async function indexWithEmbedding(docId: string, content: string) {
  const es = EmbeddingService.getInstance();
  const db = MemoryDatabase.getInstance();

  // Generate embedding
  const vector = await es.embed(content);

  // Store in database
  await db.upsertEmbedding(docId, vector, es.getModelInfo().name);
}

async function findSimilar(docIds: string[], query: string) {
  const es = EmbeddingService.getInstance();
  const db = MemoryDatabase.getInstance();

  const queryVec = await es.embed(query);
  const results: { docId: string; similarity: number }[] = [];

  for (const docId of docIds) {
    const emb = await db.getEmbedding(docId);
    if (emb) {
      const sim = EmbeddingService.cosineSimilarity(
        queryVec,
        new Float32Array(emb.vector)
      );
      results.push({ docId, similarity: sim });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 10);
}
```
