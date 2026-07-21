import { describe, it, expect } from 'vitest';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PORT,
  API_PORT,
  DEFAULT_HOST,
  DEFAULT_MAIN_AGENT_ID,
  DEFAULT_CONTEXT_WINDOW,
  MAX_TOOL_RESULT_CHARS,
  TOOL_RESULT_HEAD_TAIL,
  COMPRESSION_TRIGGER_RATIO,
  SUMMARY_MAX_TOKENS,
  IMAGE_TOKEN_ESTIMATE,
  MAX_TURNS_DEFAULT,
  STALL_DETECTION_NO_TOOL_TURNS,
  STALL_DETECTION_CONSECUTIVE_FAILURES,
  MAX_API_RETRIES,
  MAX_TOOL_RETRIES,
  API_BACKOFF_BASE_MS,
  API_BACKOFF_MAX_MS,
  HEARTBEAT_INTERVAL_SEC,
  TASK_TIMEOUT_SEC,
  UNRESPONSIVE_THRESHOLD_SEC,
  SHARD_MAX_LINES,
  SHARD_MAX_BYTES,
  ARCHIVE_AGE_DAYS,
  LOG_MAX_FILE_BYTES,
  LOG_MAX_FILES,
  WORKER_POOL_MAX,
  RATE_LIMIT_PER_MINUTE,
  SSE_MAX_DURATION_MS,
  MAX_MESSAGE_LENGTH,
  FILE_HISTORY_MAX_SNAPSHOTS,
  BOUNDARY_MARKER,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_MAX_BYTES,
  PATHS,
} from '../../shared/constants.js';

describe('Shared constants — application identity', () => {
  it('APP_NAME is AnoClaw', () => {
    expect(APP_NAME).toBe('AnoClaw');
  });

  it('APP_VERSION is 2.0.1', () => {
    expect(APP_VERSION).toBe('2.0.1');
  });

  it('DEFAULT_MAIN_AGENT_ID is main-agent', () => {
    expect(DEFAULT_MAIN_AGENT_ID).toBe('main-agent');
  });
});

describe('Shared constants — network defaults', () => {
  it('DEFAULT_PORT is 3456', () => {
    expect(DEFAULT_PORT).toBe(3456);
  });

  it('API_PORT is 15730', () => {
    expect(API_PORT).toBe(15730);
  });

  it('DEFAULT_HOST is 127.0.0.1', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('Shared constants — token & context limits', () => {
  it('DEFAULT_CONTEXT_WINDOW is 200000', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
  });

  it('MAX_TOOL_RESULT_CHARS is 4000', () => {
    expect(MAX_TOOL_RESULT_CHARS).toBe(4000);
  });

  it('TOOL_RESULT_HEAD_TAIL is 500', () => {
    expect(TOOL_RESULT_HEAD_TAIL).toBe(500);
  });

  it('COMPRESSION_TRIGGER_RATIO is 0.7', () => {
    expect(COMPRESSION_TRIGGER_RATIO).toBe(0.7);
  });

  it('SUMMARY_MAX_TOKENS is 12000', () => {
    expect(SUMMARY_MAX_TOKENS).toBe(12000);
  });

  it('IMAGE_TOKEN_ESTIMATE is 1600', () => {
    expect(IMAGE_TOKEN_ESTIMATE).toBe(1600);
  });
});

describe('Shared constants — agent loop', () => {
  it('MAX_TURNS_DEFAULT is 0 (unlimited)', () => {
    expect(MAX_TURNS_DEFAULT).toBe(0);
  });

  it('STALL_DETECTION_NO_TOOL_TURNS is 5', () => {
    expect(STALL_DETECTION_NO_TOOL_TURNS).toBe(5);
  });

  it('STALL_DETECTION_CONSECUTIVE_FAILURES is 3', () => {
    expect(STALL_DETECTION_CONSECUTIVE_FAILURES).toBe(3);
  });
});

describe('Shared constants — retry & backoff', () => {
  it('MAX_API_RETRIES is 10', () => {
    expect(MAX_API_RETRIES).toBe(10);
  });

  it('MAX_TOOL_RETRIES is 3', () => {
    expect(MAX_TOOL_RETRIES).toBe(3);
  });

  it('API_BACKOFF_BASE_MS is 1000 (1s)', () => {
    expect(API_BACKOFF_BASE_MS).toBe(1000);
  });

  it('API_BACKOFF_MAX_MS is 60000 (60s)', () => {
    expect(API_BACKOFF_MAX_MS).toBe(60000);
  });
});

describe('Shared constants — supervision timeouts', () => {
  it('HEARTBEAT_INTERVAL_SEC is 60', () => {
    expect(HEARTBEAT_INTERVAL_SEC).toBe(60);
  });

  it('TASK_TIMEOUT_SEC is 600 (10 min)', () => {
    expect(TASK_TIMEOUT_SEC).toBe(600);
  });

  it('UNRESPONSIVE_THRESHOLD_SEC is 180 (3 min)', () => {
    expect(UNRESPONSIVE_THRESHOLD_SEC).toBe(180);
  });

  it('timeouts are correctly ordered: heartbeat < unresponsive < task_timeout', () => {
    expect(HEARTBEAT_INTERVAL_SEC).toBeLessThan(UNRESPONSIVE_THRESHOLD_SEC);
    expect(UNRESPONSIVE_THRESHOLD_SEC).toBeLessThan(TASK_TIMEOUT_SEC);
  });
});

describe('Shared constants — JSONL sharding', () => {
  it('SHARD_MAX_LINES is 10000', () => {
    expect(SHARD_MAX_LINES).toBe(10000);
  });

  it('SHARD_MAX_BYTES is 10MB', () => {
    expect(SHARD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ARCHIVE_AGE_DAYS is 90', () => {
    expect(ARCHIVE_AGE_DAYS).toBe(90);
  });
});

describe('Shared constants — logging', () => {
  it('LOG_MAX_FILE_BYTES is 10MB', () => {
    expect(LOG_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('LOG_MAX_FILES is 10', () => {
    expect(LOG_MAX_FILES).toBe(10);
  });
});

describe('Shared constants — threading & rate limits', () => {
  it('WORKER_POOL_MAX is 8', () => {
    expect(WORKER_POOL_MAX).toBe(8);
  });

  it('RATE_LIMIT_PER_MINUTE is 10000', () => {
    expect(RATE_LIMIT_PER_MINUTE).toBe(10000);
  });

  it('SSE_MAX_DURATION_MS is 10 minutes', () => {
    expect(SSE_MAX_DURATION_MS).toBe(10 * 60 * 1000);
  });
});

describe('Shared constants — message & file limits', () => {
  it('MAX_MESSAGE_LENGTH is 64KB', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(64 * 1024);
  });

  it('FILE_HISTORY_MAX_SNAPSHOTS is 100', () => {
    expect(FILE_HISTORY_MAX_SNAPSHOTS).toBe(100);
  });

  it('BOUNDARY_MARKER is __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', () => {
    expect(BOUNDARY_MARKER).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
  });
});

describe('Shared constants — memory', () => {
  it('MEMORY_INDEX_MAX_LINES is 200', () => {
    expect(MEMORY_INDEX_MAX_LINES).toBe(200);
  });

  it('MEMORY_INDEX_MAX_BYTES is 25KB', () => {
    expect(MEMORY_INDEX_MAX_BYTES).toBe(25 * 1024);
  });
});

describe('Shared constants — PATHS', () => {
  it('has all expected path keys', () => {
    expect(PATHS).toHaveProperty('config');
    expect(PATHS).toHaveProperty('data');
    expect(PATHS).toHaveProperty('agents');
    expect(PATHS).toHaveProperty('sessions');
    expect(PATHS).toHaveProperty('memory');
    expect(PATHS).toHaveProperty('skills');
    expect(PATHS).toHaveProperty('logs');
    expect(PATHS).toHaveProperty('public');
    expect(PATHS).toHaveProperty('plugins');
  });

  it('PATHS values are stable', () => {
    expect(PATHS.config).toBe('config');
    expect(PATHS.data).toBe('data');
    expect(PATHS.agents).toBe('data/agents');
    expect(PATHS.sessions).toBe('data/sessions');
    expect(PATHS.memory).toBe('memory');
    expect(PATHS.skills).toBe('skills');
    expect(PATHS.logs).toBe('logs');
    expect(PATHS.public).toBe('src/public');
    expect(PATHS.plugins).toBe('plugins');
  });
});
