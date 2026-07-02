// Application-wide constants and defaults

export const APP_NAME = 'AnoClaw';
export const APP_VERSION = '2.0.0';
export const DEFAULT_PORT = 3456;
export const API_PORT = 15730;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAIN_AGENT_ID = 'main-agent';

// Token limits
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const MAX_TOOL_RESULT_CHARS = 4000;
export const TOOL_RESULT_HEAD_TAIL = 500;
export const COMPRESSION_TRIGGER_RATIO = 0.7;   // 70% of context window
export const SUMMARY_MAX_TOKENS = 12000;
export const IMAGE_TOKEN_ESTIMATE = 1600;

// Agent loop
// ReAct loop: 0 = unlimited. Agent exits when no more tool calls or user interrupts.
export const MAX_TURNS_DEFAULT = 0;
export const STALL_DETECTION_NO_TOOL_TURNS = 5;
export const STALL_DETECTION_CONSECUTIVE_FAILURES = 3;

// Retry
export const MAX_API_RETRIES = 10;
export const MAX_TOOL_RETRIES = 3;
export const API_BACKOFF_BASE_MS = 1000;
export const API_BACKOFF_MAX_MS = 60000;

// Supervision
export const HEARTBEAT_INTERVAL_SEC = 60;
export const TASK_TIMEOUT_SEC = 600;
export const UNRESPONSIVE_THRESHOLD_SEC = 180;

// JSONL sharding
export const SHARD_MAX_LINES = 10000;
export const SHARD_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_AGE_DAYS = 90;

// Logging
export const LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const LOG_MAX_FILES = 10;

// Threading
export const WORKER_POOL_MAX = 8;

// Rate limiting
export const RATE_LIMIT_PER_MINUTE = 10000;
export const SSE_MAX_DURATION_MS = 10 * 60 * 1000;
export const MAX_MESSAGE_LENGTH = 64 * 1024;

// File history
export const FILE_HISTORY_MAX_SNAPSHOTS = 100;

// Prompt cache
export const BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

// Memory (legacy file-based)
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

// Memory v2 — hybrid SQLite + vector + BM25
export const MEMORY_SQLITE_DB = 'memory.db';
export const MEMORY_EMBEDDING_DIM = 384;           // all-MiniLM-L6-v2
export const MEMORY_BM25_K1 = 1.2;                 // term frequency saturation
export const MEMORY_BM25_B = 0.75;                  // length normalization
export const MEMORY_DEFAULT_TOP_K = 10;
export const MEMORY_MAX_TOP_K = 100;
export const MEMORY_HYBRID_BM25_WEIGHT = 0.3;
export const MEMORY_HYBRID_VECTOR_WEIGHT = 0.7;
export const MEMORY_AUTO_SAVE_INTERVAL_MS = 5000;
export const MEMORY_MAX_DOCUMENTS = 10000;
export const MEMORY_MIN_SCORE_THRESHOLD = 0.1;

// Paths (relative to project root)
export const PATHS = {
  config: 'config',
  data: 'data',
  agents: 'data/agents',
  sessions: 'data/sessions',
  memory: 'memory',
  skills: 'skills',
  logs: 'logs',
  public: 'src/public',
  plugins: 'plugins',
} as const;
