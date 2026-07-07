/**
 * Shared network helper for web-facing tools (WebSearch, WebFetch).
 *
 * Uses system-native curl (Git Bash's curl.exe on Windows) instead of Node.js fetch().
 * This inherits the system's DNS, proxy, SSL certificate store — matching the behavior
 * of running curl in Git Bash.
 */
import { execFile, type ChildProcess } from 'node:child_process';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Ordered list of curl paths to try. First match wins. */
const CURL_CANDIDATES = [
  'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
  'C:\\Program Files\\Git\\usr\\bin\\curl.exe',
  'curl.exe',
  'curl',
];

let _curlPath: string | null = null;

export interface FetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Minimal Response-like object returned by webFetch. */
class CurlResponse {
  ok: boolean;
  status: number;
  statusText: string;
  private _headers: Map<string, string>;
  private _body: string;

  constructor(status: number, headers: Map<string, string>, body: string) {
    this.status = status;
    this.ok = status >= 200 && status < 400;
    this.statusText = STATUS_TEXTS[status] || `${status}`;
    this._headers = headers;
    this._body = body;
  }

  get headers(): { get(name: string): string | null } {
    const h = this._headers;
    return {
      get(name: string) {
        return h.get(name.toLowerCase()) || null;
      },
    };
  }

  async text(): Promise<string> {
    return this._body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this._body);
  }
}

const STATUS_TEXTS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** Execute curl and return a Response-like object. */
function execCurl(url: string, opts: FetchOptions, curlPath: string): Promise<CurlResponse> {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',                    // silent, but show errors on stderr
      '-L',                     // follow redirects
      '-i',                     // include HTTP response headers in output
      '--max-time', '90',       // total timeout (seconds)
      '--connect-timeout', '30', // connection timeout (seconds)
      '-H', `User-Agent: ${UA}`,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.9',
    ];

    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        args.push('-H', `${key}: ${value}`);
      }
    }

    args.push(url);

    let child: ChildProcess;
    try {
      child = execFile(curlPath, args, {
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: 120_000,            // slightly more than curl's --max-time
        env: process.env,            // inherit system env (proxy, SSL_CERT_FILE, etc.)
        windowsHide: true,
      });
    } catch (err) {
      // execFile throws sync only if the binary can't be launched at all
      reject(err);
      return;
    }

    let settled = false;

    if (opts.signal) {
      if (opts.signal.aborted) {
        settled = true;
        child.kill();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          settled = true;
          child.kill();
        },
        { once: true },
      );
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err: Error & { code?: string }) => {
      if (settled) return;
      settled = true;

      // ENOENT → binary not found; try next candidate
      if (err.code === 'ENOENT') {
        reject(new Error('CURL_NOT_FOUND'));
        return;
      }
      reject(err);
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;

      if (opts.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      if (code !== 0 && code !== null) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }

      const { status, headers, body } = parseHeadersAndBody(stdout);
      resolve(new CurlResponse(status, headers, body));
    });
  });
}

/** Parse HTTP response from curl -iL output. With -L, curl emits headers for every
 *  redirect hop. We extract the LAST response (status + headers) and its body. */
function parseHeadersAndBody(raw: string): {
  status: number;
  headers: Map<string, string>;
  body: string;
} {
  // Split on \r\n\r\n to find header/body boundaries.
  // With redirects, we get: H1 + CRLF CRLF + H2 + CRLF CRLF + ... + Hn + CRLF CRLF + body
  // Strategy: find the LAST occurrence of CRLF CRLF preceded by an HTTP/ status line.
  const blocks = splitHeaderBodyBlocks(raw);

  if (blocks.length === 0) {
    return { status: 200, headers: new Map(), body: raw };
  }

  // Use the last block
  const last = blocks[blocks.length - 1];
  return { status: last.status, headers: last.headers, body: last.body };
}

/** Split raw curl -iL output into a list of {status, headers, body} blocks.
 *  The final block has the actual response body; earlier blocks have empty bodies. */
function splitHeaderBodyBlocks(raw: string): Array<{
  status: number;
  headers: Map<string, string>;
  body: string;
}> {
  const blocks: Array<{ status: number; headers: Map<string, string>; body: string }> = [];
  let remaining = raw;

  while (remaining.length > 0) {
    // Find next HTTP/ status line
    const httpIdx = remaining.search(/^HTTP\/\d\.\d\s+\d+/m);
    if (httpIdx === -1) break;

    // Skip to the HTTP/ line
    if (httpIdx > 0) {
      remaining = remaining.slice(httpIdx);
    }

    const sepIdx = remaining.indexOf('\r\n\r\n');
    if (sepIdx === -1) {
      // No complete header block found; treat rest as body of last block
      if (blocks.length > 0) {
        blocks[blocks.length - 1].body = remaining;
      }
      break;
    }

    const headerSection = remaining.slice(0, sepIdx);
    const afterHeaders = remaining.slice(sepIdx + 4);

    // Check if there's another HTTP/ response after this header block
    const nextHttp = afterHeaders.search(/^HTTP\/\d\.\d\s+\d+/m);

    if (nextHttp !== -1) {
      // This is an intermediate response (redirect) — body is empty
      const { status, headers } = parseHeaderSection(headerSection);
      blocks.push({ status, headers, body: '' });
      remaining = afterHeaders.slice(nextHttp);
    } else {
      // This is the final response — everything after headers is the body
      const { status, headers } = parseHeaderSection(headerSection);
      blocks.push({ status, headers, body: afterHeaders });
      break;
    }
  }

  return blocks;
}

/** Parse a single header section (lines of "Key: Value") into status + headers map. */
function parseHeaderSection(headerSection: string): { status: number; headers: Map<string, string> } {
  const lines = headerSection.split(/\r?\n/);
  let status = 200;
  const headers = new Map<string, string>();

  for (const line of lines) {
    if (line.startsWith('HTTP/')) {
      const m = line.match(/^HTTP\/\d\.\d\s+(\d+)/);
      if (m) status = parseInt(m[1], 10);
    } else {
      const ci = line.indexOf(':');
      if (ci > 0) {
        headers.set(line.slice(0, ci).toLowerCase(), line.slice(ci + 1).trim());
      }
    }
  }

  return { status, headers };
}

/** Try each curl candidate path until one works, then cache the winner. */
async function tryCurlPaths(url: string, opts: FetchOptions): Promise<CurlResponse> {
  // If we already found a working path, use it
  if (_curlPath) {
    return execCurl(url, opts, _curlPath);
  }

  // Probe candidates
  const errors: string[] = [];
  for (const candidate of CURL_CANDIDATES) {
    try {
      const resp = await execCurl(url, opts, candidate);
      // Success — cache this path
      _curlPath = candidate;
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'CURL_NOT_FOUND') {
        errors.push(`${candidate} (not found)`);
        continue;
      }
      // Other errors (network, HTTP) — the binary works, cache and rethrow
      _curlPath = candidate;
      throw err;
    }
  }

  throw new Error(
    `Cannot find curl executable. Tried:\n${errors.join('\n')}\nEnsure Git Bash is installed.`,
  );
}

/**
 * Fetch a URL using system curl.
 *
 * Uses system-native curl.exe (Git Bash on Windows) so the network environment
 * (DNS, proxy, SSL certs) matches the user's terminal exactly.
 */
export async function webFetch(url: string, opts: FetchOptions = {}): Promise<CurlResponse> {
  return tryCurlPaths(url, opts);
}
