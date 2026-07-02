// APIScheduler — rate-limit-aware request scheduler
// Singleton that gates LLM API calls per API key to avoid 429 responses.
// Uses a sliding-window approach: tracks request timestamps and estimated
// token usage, delaying acquireSlot() until capacity is available.

import { EventEmitter } from 'events';
import { RATE_LIMIT_PER_MINUTE } from '../../../shared/constants.js';

// ── Types ──

interface RateLimit {
  rpm: number;   // requests per minute
  tpm: number;   // tokens per minute
  remaining: number;
  resetAt: number; // epoch ms
}

interface KeyState {
  rpm: number;
  tpm: number;
  requestTimestamps: number[];  // sliding window of request times (ms)
  tokenUsageTimestamps: Array<{ ts: number; tokens: number }>; // sliding window
  remainingRequests: number;
  remainingTokens: number;
  resetAt: number;
}

// ── Constants ──

const DEFAULT_RPM = RATE_LIMIT_PER_MINUTE;
const DEFAULT_TPM = 50_000_000; // tokens per minute — effectively unlimited for single-user
const WINDOW_MS = 60_000;    // 1 minute sliding window
const POLL_INTERVAL_MS = 50; // how often to recheck when waiting

// ── Helper: truncate API key to a safe prefix for logging ──

function keyPrefix(apiKey: string): string {
  if (!apiKey) return 'anon';
  return apiKey.slice(0, 8) + '...';
}

// ── APIScheduler ──

export class APIScheduler extends EventEmitter {
  private static _instance: APIScheduler | null = null;

  static getInstance(): APIScheduler {
    if (!APIScheduler._instance) {
      APIScheduler._instance = new APIScheduler();
    }
    return APIScheduler._instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    APIScheduler._instance = null;
  }

  private _states: Map<string, KeyState> = new Map();

  private constructor() {
    super();
  }

  // ── Acquire slot ──

  /**
   * Wait until a request slot is available for this API key.
   * Uses a sliding-window algorithm: if the number of requests in the
   * past 60 seconds exceeds rpm, or estimated tokens exceed tpm, we
   * wait until enough old entries expire.
   *
   * @param apiKey         - The API key (used as the rate-limit bucket key)
   * @param estimatedTokens - Estimated token count for this request (input + output)
   */
  async acquireSlot(apiKey: string, estimatedTokens: number): Promise<void> {
    const prefix = keyPrefix(apiKey);
    let state = this._states.get(prefix);

    if (!state) {
      state = this._initState();
      this._states.set(prefix, state);
    }

    // Wait until we have capacity
    while (true) {
      const now = Date.now();
      this._prune(state, now);

      const requestCount = state.requestTimestamps.length;
      const tokenSum = state.tokenUsageTimestamps.reduce((s, e) => s + e.tokens, 0);

      const rpmOk = requestCount < state.rpm;
      const tpmOk = (tokenSum + estimatedTokens) <= state.tpm;

      if (rpmOk && tpmOk) {
        // Reserve the slot
        state.requestTimestamps.push(now);
        state.tokenUsageTimestamps.push({ ts: now, tokens: estimatedTokens });
        state.remainingRequests = Math.max(0, state.rpm - requestCount - 1);
        state.remainingTokens = Math.max(0, state.tpm - tokenSum - estimatedTokens);
        return;
      }

      // Calculate how long to wait
      let waitMs = POLL_INTERVAL_MS;

      if (!rpmOk && state.requestTimestamps.length > 0) {
        // Wait until the oldest request expires from the window
        const oldest = state.requestTimestamps[0];
        const expiresAt = oldest + WINDOW_MS;
        waitMs = Math.max(waitMs, expiresAt - now + 10);
      }

      if (!tpmOk && state.tokenUsageTimestamps.length > 0) {
        // Wait until enough token budget frees up
        const oldest = state.tokenUsageTimestamps[0];
        const expiresAt = oldest.ts + WINDOW_MS;
        waitMs = Math.max(waitMs, expiresAt - now + 10);
      }

      // Clamp wait — 2s max avoids frontend freeze; if rate limit is actually
      // hit, the API will 429 and AgentLoopLLM retry handles it gracefully.
      waitMs = Math.min(waitMs, 2000);

      this.emit('waiting', { apiKey: prefix, waitMs, requestCount, tokenSum });

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // ── Update from response headers ──

  /**
   * Update rate limit state from API response headers.
   * Call this after each successful API response.
   *
   * Supported headers:
   *   x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens,
   *   x-ratelimit-reset-requests, x-ratelimit-reset-tokens,
   *   retry-after
   */
  updateFromHeaders(apiKey: string, headers: Record<string, string>): void {
    const prefix = keyPrefix(apiKey);
    let state = this._states.get(prefix);

    if (!state) {
      state = this._initState();
      this._states.set(prefix, state);
    }

    const now = Date.now();

    // Parse remaining requests
    const remainingReqs = headers['x-ratelimit-remaining-requests'];
    if (remainingReqs !== undefined) {
      state.remainingRequests = parseInt(remainingReqs, 10);
    }

    // Parse remaining tokens
    const remainingToks = headers['x-ratelimit-remaining-tokens'];
    if (remainingToks !== undefined) {
      state.remainingTokens = parseInt(remainingToks, 10);
    }

    // Parse reset timestamps
    const resetReqs = headers['x-ratelimit-reset-requests'];
    if (resetReqs !== undefined) {
      state.resetAt = parseInt(resetReqs, 10) * 1000; // assume unix seconds
    }

    const resetToks = headers['x-ratelimit-reset-tokens'];
    if (resetToks !== undefined) {
      const tokReset = parseInt(resetToks, 10) * 1000;
      state.resetAt = Math.max(state.resetAt, tokReset);
    }

    // Retry-After header
    const retryAfter = headers['retry-after'];
    if (retryAfter !== undefined) {
      const retrySec = parseInt(retryAfter, 10);
      if (!isNaN(retrySec)) {
        state.resetAt = Math.max(state.resetAt, now + retrySec * 1000);
      }
    }

    this.emit('headersUpdated', {
      apiKey: prefix,
      remainingRequests: state.remainingRequests,
      remainingTokens: state.remainingTokens,
    });
  }

  // ── Query remaining capacity ──

  /** Get remaining request count (approximate, from last header update). */
  remainingRequests(apiKey: string): number {
    const state = this._states.get(keyPrefix(apiKey));
    if (!state) return DEFAULT_RPM;
    this._prune(state, Date.now());
    return state.remainingRequests;
  }

  /** Get remaining token budget (approximate, from last header update). */
  remainingTokens(apiKey: string): number {
    const state = this._states.get(keyPrefix(apiKey));
    if (!state) return DEFAULT_TPM;
    this._prune(state, Date.now());
    return state.remainingTokens;
  }

  // ── Private helpers ──

  private _initState(): KeyState {
    return {
      rpm: DEFAULT_RPM,
      tpm: DEFAULT_TPM,
      requestTimestamps: [],
      tokenUsageTimestamps: [],
      remainingRequests: DEFAULT_RPM,
      remainingTokens: DEFAULT_TPM,
      resetAt: Date.now() + WINDOW_MS,
    };
  }

  /** Remove entries outside the sliding window. */
  private _prune(state: KeyState, now: number): void {
    const cutoff = now - WINDOW_MS;

    // Prune request timestamps
    while (state.requestTimestamps.length > 0 && state.requestTimestamps[0] < cutoff) {
      state.requestTimestamps.shift();
    }

    // Prune token usage timestamps
    while (state.tokenUsageTimestamps.length > 0 && state.tokenUsageTimestamps[0].ts < cutoff) {
      state.tokenUsageTimestamps.shift();
    }
  }
}
