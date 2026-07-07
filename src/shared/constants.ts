// Application-wide constants and defaults

/** Application display name. */
export const APP_NAME = 'AnoClaw';
/** Application version string. */
export const APP_VERSION = '2.0.0';
/** Default HTTP port for the main web server. */
export const DEFAULT_PORT = 3456;
/** REST API port, localhost-only for external agent control. */
export const API_PORT = 15730;
/** Default bind address. */
export const DEFAULT_HOST = '127.0.0.1';
/** ID of the built-in main agent. */
export const DEFAULT_MAIN_AGENT_ID = 'main-agent';

// Token limits
/** Default LLM context window size in tokens. */
export const DEFAULT_CONTEXT_WINDOW = 200000;
/** Maximum characters to include from a tool result in the prompt. */
export const MAX_TOOL_RESULT_CHARS = 4000;
/** Head/tail character count for truncated tool result display. */
export const TOOL_RESULT_HEAD_TAIL = 500;
/** Trigger compaction when context usage exceeds this ratio of the context window. */
export const COMPRESSION_TRIGGER_RATIO = 0.7;
/** Maximum token budget for summarization. */
export const SUMMARY_MAX_TOKENS = 12000;
/** Estimated token count for a single image in the prompt. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

// Agent loop
/** Default max turns per ReAct loop (0 = unlimited). */
export const MAX_TURNS_DEFAULT = 0;
/** Stall detection: consecutive turns without a tool call. */
export const STALL_DETECTION_NO_TOOL_TURNS = 5;
/** Stall detection: consecutive failed tool calls. */
export const STALL_DETECTION_CONSECUTIVE_FAILURES = 3;

// Retry
/** Maximum API retry attempts before giving up. */
export const MAX_API_RETRIES = 10;
/** Maximum tool execution retry attempts. */
export const MAX_TOOL_RETRIES = 3;
/** Base backoff delay in milliseconds for API retries. */
export const API_BACKOFF_BASE_MS = 1000;
/** Maximum backoff delay in milliseconds for API retries. */
export const API_BACKOFF_MAX_MS = 60000;

// Supervision
/** Interval in seconds between heartbeat pings. */
export const HEARTBEAT_INTERVAL_SEC = 60;
/** Maximum task execution time in seconds before timeout. */
export const TASK_TIMEOUT_SEC = 600;
/** Threshold in seconds before an agent is marked unresponsive. */
export const UNRESPONSIVE_THRESHOLD_SEC = 180;

// JSONL sharding
/** Maximum lines per JSONL shard file before rotation. */
export const SHARD_MAX_LINES = 10000;
/** Maximum bytes per JSONL shard file (10 MB). */
export const SHARD_MAX_BYTES = 10 * 1024 * 1024;
/** Days before a session is eligible for archival. */
export const ARCHIVE_AGE_DAYS = 90;

// Logging
/** Maximum log file size in bytes before rotation. */
export const LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Maximum number of rotated log files to retain. */
export const LOG_MAX_FILES = 10;

// Threading
/** Maximum worker pool size for parallel operations. */
export const WORKER_POOL_MAX = 8;

// Rate limiting
/** Maximum requests per minute for rate-limited endpoints. */
export const RATE_LIMIT_PER_MINUTE = 10000;
/** Maximum SSE connection duration in milliseconds. */
export const SSE_MAX_DURATION_MS = 10 * 60 * 1000;
/** Maximum accepted WebSocket message length in bytes. */
export const MAX_MESSAGE_LENGTH = 64 * 1024;

// LLM provider names
/** Provider key for Ollama local LLM server. */
export const PROVIDER_OLLAMA = 'ollama' as const;
/** Provider key for OpenAI-compatible API endpoints. */
export const PROVIDER_OPENAI_COMPATIBLE = 'openai-compatible' as const;

// File history
/** Maximum number of file snapshots retained for version history. */
export const FILE_HISTORY_MAX_SNAPSHOTS = 100;

// Prompt cache
/** Marker string separating static and dynamic sections of the system prompt. */
export const BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

// Memory (legacy file-based)
/** Maximum lines in the memory index file. */
export const MEMORY_INDEX_MAX_LINES = 200;
/** Maximum bytes in the memory index file. */
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

// Memory v2 — hybrid SQLite + vector + BM25
/** SQLite database filename for memory v2. */
export const MEMORY_SQLITE_DB = 'memory.db';
/** Embedding vector dimension (all-MiniLM-L6-v2). */
export const MEMORY_EMBEDDING_DIM = 384;
/** BM25 k1 parameter for term frequency saturation. */
export const MEMORY_BM25_K1 = 1.2;
/** BM25 b parameter for document length normalization. */
export const MEMORY_BM25_B = 0.75;
/** Default number of top results for memory retrieval. */
export const MEMORY_DEFAULT_TOP_K = 10;
/** Maximum number of top results for memory retrieval. */
export const MEMORY_MAX_TOP_K = 100;
/** Weight of BM25 score in hybrid retrieval. */
export const MEMORY_HYBRID_BM25_WEIGHT = 0.3;
/** Weight of vector similarity score in hybrid retrieval. */
export const MEMORY_HYBRID_VECTOR_WEIGHT = 0.7;
/** Auto-save interval in milliseconds for memory persistence. */
export const MEMORY_AUTO_SAVE_INTERVAL_MS = 5000;
/** Maximum number of documents stored in memory. */
export const MEMORY_MAX_DOCUMENTS = 10000;
/** Minimum score threshold for memory retrieval results. */
export const MEMORY_MIN_SCORE_THRESHOLD = 0.1;

// Paths (relative to project root)
/** Standard directory paths within the project. */
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
