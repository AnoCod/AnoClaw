import { describe, it, expect } from 'vitest';

// These are replicas of the regex patterns used in AgentLoopLLM.ts and ToolPipeline.ts.
// The tests verify that the patterns match (and don't match) expected error strings.

const RETRYABLE = [
  /429|rate.?limit|too many requests|busy|overloaded|throttled/i,
  /5\d\d|server.*error|internal.*error|bad gateway|service.*unavailable|temporarily.*unavailable|maintenance/i,
  /network|ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|socket|timeout|fetch.*failed|abort|connection|timeout/i,
  /overloaded|capacity|busy|congestion/i,
];

const UNRETRYABLE = [
  /40[0-9]|bad.?request|invalid|tool.*must|message.*role|not.?found|unauthorized|forbidden|payment|quota|billing/i,
];

const PIPELINE_RETRYABLE = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE/,
  /network|connection|timeout|fetch.*failed|abort|socket/i,
  /rate.?limit|too many requests|busy|overloaded|throttled/i,
  /5\d\d|server.*error|internal.*error|bad gateway|service.*unavailable/i,
];

const PIPELINE_USER_VISIBLE = [
  /ENOENT|no such file|not found/i,
  /EACCES|permission denied|access denied/i,
  /invalid|bad request|malformed/i,
];

function anyMatch(patterns: RegExp[], msg: string): boolean {
  return patterns.some((r) => r.test(msg));
}

describe('AgentLoopLLM error classification', () => {
  describe('RETRYABLE patterns', () => {
    const cases = [
      '429 Too Many Requests',
      'Rate limit exceeded, try again later',
      '503 Service Unavailable',
      '500 Internal Server Error',
      'Bad Gateway error from proxy',
      'Temporarily Unavailable for maintenance',
      'Network error: ECONNREFUSED',
      'ETIMEDOUT: connection timed out',
      'ENOTFOUND: dns lookup failed',
      'EPIPE: broken pipe',
      'socket hang up',
      'fetch failed: connection refused',
      'Request aborted due to timeout',
      'Server overloaded, please retry',
      'System at capacity, try later',
      'Congestion detected on the network',
    ];

    for (const msg of cases) {
      it(`matches: "${msg}"`, () => {
        expect(anyMatch(RETRYABLE, msg)).toBe(true);
      });
    }
  });

  describe('UNRETRYABLE patterns', () => {
    const cases = [
      '400 Bad Request',
      '401 Unauthorized',
      '403 Forbidden',
      '404 Not Found',
      'Invalid request parameters',
      'Tool call must include a valid function name',
      'Message role is required',
      'Payment required: quota exceeded',
      'Billing account suspended',
    ];

    for (const msg of cases) {
      it(`matches: "${msg}"`, () => {
        expect(anyMatch(UNRETRYABLE, msg)).toBe(true);
      });
    }
  });

  it('permanent errors are NOT matched by retryable patterns', () => {
    const permanent = '401 Unauthorized: invalid API key';
    expect(anyMatch(RETRYABLE, permanent)).toBe(false);
  });
});

describe('ToolPipeline error classification', () => {
  describe('PIPELINE_RETRYABLE', () => {
    const retryable = [
      'ECONNRESET: socket closed',
      'ECONNREFUSED: port not open',
      'ETIMEDOUT: operation timeout',
      'ENOTFOUND: host not found',
      'EPIPE: broken pipe',
      'Network error during fetch',
      'Connection lost, please reconnect',
      'fetch failed with timeout',
      'Socket abort signal received',
      'Rate limit exceeded: try again in 5s',
      'Too many requests from this IP',
      'Server is busy, retry later',
      'API overloaded',
      '503 Service Unavailable',
      '500 Internal Server Error',
      'Bad Gateway 502',
    ];

    for (const msg of retryable) {
      it(`matches: "${msg}"`, () => {
        expect(anyMatch(PIPELINE_RETRYABLE, msg)).toBe(true);
      });
    }
  });

  describe('PIPELINE_USER_VISIBLE (not retried)', () => {
    const userVisible = [
      'ENOENT: no such file or directory',
      'File not found: /path/to/missing.txt',
      'EACCES: permission denied',
      'Access denied for user',
      'Invalid argument: expected number',
      'Bad request: malformed JSON',
    ];

    for (const msg of userVisible) {
      it(`matches: "${msg}"`, () => {
        expect(anyMatch(PIPELINE_USER_VISIBLE, msg)).toBe(true);
      });
    }
  });

  it('user-visible errors are NOT retried by pipeline', () => {
    const msg = 'ENOENT: no such file';
    expect(anyMatch(PIPELINE_RETRYABLE, msg)).toBe(false);
  });
});
