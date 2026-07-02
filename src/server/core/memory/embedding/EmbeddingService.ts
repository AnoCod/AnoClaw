/**
 * EmbeddingService — ONNX-based text embedding for memory v2.
 *
 * Lazy initialization: model is loaded only on first embed() call, not at import time.
 * Fallback: if ONNX fails to load or model files are missing, returns zero vectors
 * (384 zeros). Memory degrades to keyword-only but does not crash.
 *
 * Singleton: getInstance() + resetInstance().
 *
 * Model: all-MiniLM-L6-v2 (384-dimensional embeddings).
 * Expected path: data/models/all-MiniLM-L6-v2/model.onnx
 *                data/models/all-MiniLM-L6-v2/tokenizer.json
 */

import { createLogger } from '../../logger.js';
import type { MemoryEmbeddingModel } from '../../../../shared/types/memory.js';
import { MEMORY_EMBEDDING_DIM } from '../../../../shared/constants.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createLogger('anochat.memory.embedding');

// ── Paths ───────────────────────────────────────────────────────────────────

const MODEL_DIR = path.resolve('data/models/all-MiniLM-L6-v2');
const MODEL_PATH = path.join(MODEL_DIR, 'model.onnx');
const TOKENIZER_PATH = path.join(MODEL_DIR, 'tokenizer.json');
const MODEL_NAME = 'all-MiniLM-L6-v2';
const MAX_SEQ_LENGTH = 256;

// ── Simple tokenizer (BM25 / keyword use) ──────────────────────────────────

const TOKEN_SPLIT_RE = /[\s,.:;!?()\[\]{}"'`/\\|@#$%^&*+=<>~-]+/;

/**
 * Split text into lowercase tokens of length >= 2.
 * Used for BM25 indexing, not for the embedding model.
 */
export function splitTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter(t => t.length >= 2);
}

// ── WordPiece tokenizer (parsed from tokenizer.json) ──────────────────────

interface VocabMap {
  [token: string]: number;
}

interface TokenizerConfig {
  unkToken: string;
  clsToken: string;
  sepToken: string;
  padToken: string;
}

interface TokenizeResult {
  inputIds: bigint[];
  attentionMask: bigint[];
}

const DEFAULT_SPECIAL_TOKENS: TokenizerConfig = {
  unkToken: '[UNK]',
  clsToken: '[CLS]',
  sepToken: '[SEP]',
  padToken: '[PAD]',
};

class WordPieceTokenizer {
  private vocab: VocabMap;
  private unkId: number;
  private clsId: number;
  private sepId: number;
  private padId: number;
  private maxLength: number;

  constructor(vocab: VocabMap, specialTokens?: Partial<TokenizerConfig>, maxLength?: number) {
    this.vocab = vocab;

    const cfg = { ...DEFAULT_SPECIAL_TOKENS, ...specialTokens };
    this.unkId = vocab[cfg.unkToken];
    this.clsId = vocab[cfg.clsToken];
    this.sepId = vocab[cfg.sepToken];
    this.padId = vocab[cfg.padToken];
    this.maxLength = maxLength ?? MAX_SEQ_LENGTH;

    if (this.unkId === undefined || this.clsId === undefined || this.sepId === undefined) {
      throw new Error(
        `Tokenizer vocab missing special tokens. Found unk=${this.unkId}, cls=${this.clsId}, sep=${this.sepId}`
      );
    }
  }

  /**
   * WordPiece tokenization: split on whitespace/punctuation, then
   * longest-match-first subword decomposition with ## prefix.
   */
  encode(text: string): TokenizeResult {
    const preTokens = this.preTokenize(text);
    const ids: number[] = [this.clsId];

    for (const word of preTokens) {
      if (word in this.vocab) {
        ids.push(this.vocab[word]);
      } else {
        // WordPiece subword decomposition
        let start = 0;
        while (start < word.length) {
          let end = word.length;
          let found = false;
          while (start < end) {
            const sub = (start === 0 ? '' : '##') + word.slice(start, end);
            if (sub in this.vocab) {
              ids.push(this.vocab[sub]);
              found = true;
              break;
            }
            end--;
          }
          if (!found) {
            ids.push(this.unkId);
            break;
          }
          start = end;
        }
      }

      if (ids.length >= this.maxLength - 1) break;
    }

    ids.push(this.sepId);

    // Truncate to maxLength
    const finalIds = ids.slice(0, this.maxLength);
    const seqLen = finalIds.length;

    // Pad to maxLength
    const inputIds: bigint[] = [];
    const attentionMask: bigint[] = [];
    for (let i = 0; i < this.maxLength; i++) {
      if (i < seqLen) {
        inputIds.push(BigInt(finalIds[i]));
        attentionMask.push(1n);
      } else {
        inputIds.push(BigInt(this.padId));
        attentionMask.push(0n);
      }
    }

    return { inputIds, attentionMask };
  }

  private preTokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(TOKEN_SPLIT_RE)
      .filter(t => t.length > 0);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tryParseTokenizerJson(raw: string): VocabMap | null {
  try {
    const parsed = JSON.parse(raw);
    const vocab = parsed?.model?.vocab;
    if (!vocab || typeof vocab !== 'object') {
      log.warn('tokenizer.json missing model.vocab field');
      return null;
    }
    // Validate: at least a few thousand entries
    const keys = Object.keys(vocab);
    if (keys.length < 1000) {
      log.warn(`tokenizer.json vocab too small: ${keys.length} entries, expected ~30522`);
      return null;
    }
    return vocab as VocabMap;
  } catch (err) {
    log.warn('Failed to parse tokenizer.json', { error: String(err) });
    return null;
  }
}

function zeroVector(): Float32Array {
  return new Float32Array(MEMORY_EMBEDDING_DIM); // all zeros
}

// ── EmbeddingService ────────────────────────────────────────────────────────

export class EmbeddingService {
  private static _instance: EmbeddingService | null = null;

  private _session: unknown = null;        // ort.InferenceSession | null
  private _tokenizer: WordPieceTokenizer | null = null;
  private _fallback = false;
  private _initAttempted = false;
  private _initPromise: Promise<void> | null = null;
  private _disposed = false;

  // ── Singleton ──────────────────────────────────────────────────────────

  static getInstance(): EmbeddingService {
    if (!EmbeddingService._instance) {
      EmbeddingService._instance = new EmbeddingService();
    }
    return EmbeddingService._instance;
  }

  static resetInstance(): void {
    if (EmbeddingService._instance) {
      EmbeddingService._instance.dispose();
      EmbeddingService._instance = null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  isReady(): boolean {
    return !this._fallback && this._initAttempted && this._session !== null && this._tokenizer !== null;
  }

  getModelInfo(): MemoryEmbeddingModel {
    return {
      name: MODEL_NAME,
      dimension: MEMORY_EMBEDDING_DIM,
      loaded: this.isReady(),
    };
  }

  /**
   * Embed a single text string. Returns Float32Array of MEMORY_EMBEDDING_DIM floats.
   * If the model is not ready (fallback mode), returns a zero vector.
   */
  async embed(text: string): Promise<Float32Array> {
    const ready = await this.ensureInit();
    if (!ready || !this._tokenizer || !this._session) {
      return zeroVector();
    }

    if (!text || text.trim().length === 0) {
      return zeroVector();
    }

    try {
      return await this.runInference(text);
    } catch (err) {
      log.warn('embed inference failed, returning zero vector', { error: String(err) });
      return zeroVector();
    }
  }

  /**
   * Embed a batch of texts. Returns an array of Float32Arrays.
   * Each element is independent — a failure for one text returns a zero vector
   * for that text only.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const ready = await this.ensureInit();
    if (!ready || !this._tokenizer || !this._session) {
      return texts.map(() => zeroVector());
    }

    const results: Float32Array[] = [];
    for (const text of texts) {
      try {
        if (!text || text.trim().length === 0) {
          results.push(zeroVector());
        } else {
          results.push(await this.runInference(text));
        }
      } catch (err) {
        log.warn('embedBatch inference failed for text, returning zero vector', {
          error: String(err),
          textPreview: text.slice(0, 50),
        });
        results.push(zeroVector());
      }
    }
    return results;
  }

  /**
   * Cosine similarity between two vectors.
   * Pure static function — no model dependency.
   * Handles zero vectors by returning 0.
   */
  static cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
      const va = a[i];
      const vb = b[i];
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  /**
   * Release ONNX session resources.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // ort.InferenceSession has a release() method
    if (this._session && typeof (this._session as { release?: () => void }).release === 'function') {
      try {
        (this._session as { release: () => void }).release();
      } catch {
        // silence dispose errors
      }
    }
    this._session = null;
    this._tokenizer = null;
    this._fallback = false;
    this._initAttempted = false;
    this._initPromise = null;
  }

  // ── Initialization ─────────────────────────────────────────────────────

  /**
   * Lazy init — called on first embed(). Subsequent calls return immediately
   * if already initialized. Thread-safe: concurrent embed() calls share one
   * init promise.
   */
  private async ensureInit(): Promise<boolean> {
    if (this._disposed) return false;
    if (this._initAttempted) return !this._fallback;

    if (!this._initPromise) {
      this._initPromise = this.initialize();
    }

    await this._initPromise;
    return !this._fallback;
  }

  private async initialize(): Promise<void> {
    this._initAttempted = true;

    // ── Check model files exist ────────────────────────────────────────
    if (!fs.existsSync(MODEL_PATH)) {
      log.warn(
        `Model file not found: ${MODEL_PATH}. ` +
        `Download the all-MiniLM-L6-v2 ONNX model to ${MODEL_DIR}/. ` +
        `Expected files: model.onnx and tokenizer.json. ` +
        `Memory will use keyword-only search (no vector embeddings).`
      );
      this._fallback = true;
      return;
    }

    if (!fs.existsSync(TOKENIZER_PATH)) {
      log.warn(
        `Tokenizer file not found: ${TOKENIZER_PATH}. ` +
        `Expected files: model.onnx and tokenizer.json in ${MODEL_DIR}/. ` +
        `Memory will use keyword-only search.`
      );
      this._fallback = true;
      return;
    }

    // ── Parse tokenizer ────────────────────────────────────────────────
    try {
      const raw = fs.readFileSync(TOKENIZER_PATH, 'utf-8');
      const vocab = tryParseTokenizerJson(raw);
      if (!vocab) {
        this._fallback = true;
        return;
      }
      this._tokenizer = new WordPieceTokenizer(vocab);
    } catch (err) {
      log.warn('Failed to load tokenizer', { error: String(err) });
      this._fallback = true;
      return;
    }

    // ── Load ONNX model ────────────────────────────────────────────────
    try {
      const ort = await import('onnxruntime-node');
      this._session = await ort.InferenceSession.create(MODEL_PATH);
      log.info('ONNX model loaded', { model: MODEL_NAME, dim: MEMORY_EMBEDDING_DIM });
    } catch (err) {
      log.warn('Failed to load ONNX model', { error: String(err) });
      this._session = null;
      this._tokenizer = null;
      this._fallback = true;
    }
  }

  // ── Inference ──────────────────────────────────────────────────────────

  private async runInference(text: string): Promise<Float32Array> {
    const ort = await import('onnxruntime-node');

    if (!this._tokenizer || !this._session) {
      return zeroVector();
    }

    const session = this._session as { run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>; inputNames: string[] };

    // Tokenize
    const { inputIds, attentionMask } = this._tokenizer.encode(text);

    // Build ONNX input feeds
    const feeds: Record<string, unknown> = {};
    feeds[session.inputNames[0]] = new ort.Tensor('int64', BigInt64Array.from(inputIds), [1, this._tokenizer['maxLength']]);
    if (session.inputNames.length > 1) {
      feeds[session.inputNames[1]] = new ort.Tensor('int64', BigInt64Array.from(attentionMask), [1, this._tokenizer['maxLength']]);
    }
    // token_type_ids (input 3) — all zeros for single-sequence BERT
    if (session.inputNames.length > 2) {
      const tokenTypeIds = new BigInt64Array(this._tokenizer['maxLength']); // all zeros
      feeds[session.inputNames[2]] = new ort.Tensor('int64', tokenTypeIds, [1, this._tokenizer['maxLength']]);
    }

    // Run inference
    const outputs = await session.run(feeds);

    // Extract hidden states (output 0 is typically last_hidden_state or sentence_embedding)
    const outputKey = Object.keys(outputs)[0];
    const outputTensor = outputs[outputKey] as { data: Float32Array; dims: number[] };
    const data = outputTensor.data;
    const dims = outputTensor.dims;

    // If the model already outputs a single sentence embedding (shape [1, dim]),
    // return it directly after normalization.
    if (dims.length === 2 && dims[1] === MEMORY_EMBEDDING_DIM && dims[0] === 1) {
      const vec = new Float32Array(MEMORY_EMBEDDING_DIM);
      vec.set(data.subarray(0, MEMORY_EMBEDDING_DIM));
      return this.normalize(vec);
    }

    // Otherwise, mean-pool over the sequence dimension [1, seqLen, dim]
    if (dims.length === 3 && dims[2] === MEMORY_EMBEDDING_DIM) {
      const seqLen = dims[1];
      return this.meanPool(data, attentionMask, seqLen);
    }

    // Unexpected output shape — fall back
    log.warn('Unexpected ONNX output shape', { dims });
    return zeroVector();
  }

  /**
   * Mean-pool token embeddings weighted by attention mask, then L2-normalize.
   */
  private meanPool(data: Float32Array, attentionMask: bigint[], seqLen: number): Float32Array {
    const result = new Float32Array(MEMORY_EMBEDDING_DIM);
    let maskSum = 0;

    for (let i = 0; i < seqLen; i++) {
      const weight = Number(attentionMask[i]);
      if (weight === 0) continue;
      maskSum += weight;

      const offset = i * MEMORY_EMBEDDING_DIM;
      for (let j = 0; j < MEMORY_EMBEDDING_DIM; j++) {
        result[j] += data[offset + j];
      }
    }

    if (maskSum === 0) return zeroVector();

    // Divide by mask sum
    for (let j = 0; j < MEMORY_EMBEDDING_DIM; j++) {
      result[j] /= maskSum;
    }

    return this.normalize(result);
  }

  /**
   * L2-normalize a vector in-place.
   */
  private normalize(vec: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }
    return vec;
  }
}
