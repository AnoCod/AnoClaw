# MCP Local RAG

[![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Local RAG for developers using MCP.
Hybrid search (BM25 + semantic) for exact technical terms — fully private, zero setup.

## Features

- **Code-aware hybrid search**
  Keyword (BM25) + semantic search combined. Exact terms like `useEffect`, error codes, and class names are matched reliably—not just semantically guessed.

- **Quality-first result filtering**
  Groups results by relevance gaps instead of arbitrary top-K cutoffs. Get fewer but more trustworthy chunks.

- **Runs entirely locally**
  No API keys, no cloud, no data leaving your machine. Works fully offline after the first model download.

- **Zero-friction setup**
  One `npx` command. No Docker, no Python, no servers to manage. Designed for Cursor, Codex, and Claude Code via MCP.

## Quick Start

Set `BASE_DIR` to the folder you want to search. Documents must live under it.

Add the MCP server to your AI coding tool:

**For Cursor** — Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/your/documents"
      }
    }
  }
}
```

**For Codex** — Add to `~/.codex/config.toml`:
```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

**For Claude Code** — Run this command:
```bash
claude mcp add local-rag --scope user --env BASE_DIR=/path/to/your/documents -- npx -y mcp-local-rag
```

Restart your tool, then start using it:

```
You: "Ingest api-spec.pdf"
Assistant: Successfully ingested api-spec.pdf (47 chunks created)

You: "What does the API documentation say about authentication?"
Assistant: Based on the documentation, authentication uses OAuth 2.0 with JWT tokens.
          The flow is described in section 3.2...
```

That's it. No installation, no Docker, no complex setup.

## Why This Exists

You want AI to search your documents—technical specs, research papers, internal docs. But most solutions send your files to external APIs.

**Privacy.** Your documents might contain sensitive data. This runs entirely locally.

**Cost.** External embedding APIs charge per use. This is free after the initial model download.

**Offline.** Works without internet after setup.

**Code search.** Pure semantic search misses exact terms like `useEffect` or `ERR_CONNECTION_REFUSED`. Hybrid search catches both meaning and exact matches.

## Usage

The server provides 5 MCP tools: ingest, search, list, delete, status
(`ingest_file`, `query_documents`, `list_files`, `delete_file`, `status`).

The server provides six tools through MCP:

**Document ingestion** handles PDF, DOCX, TXT, Markdown, and code files (TypeScript, JavaScript, Python, Java, Go, Rust, C/C++, Ruby, PHP, C#, Shell, SQL). Point it at a file, and it extracts the text, splits it into searchable chunks, generates embeddings using a local model, and stores everything in a local vector database. If you ingest the same file again, it replaces the old version—no duplicate data.

**Text snippet memorization** lets you store code snippets, notes, or any text directly without file I/O using the `memorize_text` tool. Perfect for quick note-taking or caching frequently referenced code. Snippets are stored with synthetic paths like `memory://label` and can be deleted like regular files.

**Semantic search** uses hybrid search combining BM25 keyword matching with vector similarity. Ask "how does authentication work" and it finds relevant sections using both exact keyword matches and semantic understanding.

**File management** shows what you've ingested and when. You can see how many chunks each file produced and verify everything is indexed correctly.

**File deletion** removes ingested documents from the vector database. When you delete a file, all its chunks and embeddings are permanently removed. This is useful for removing outdated documents or sensitive data you no longer want indexed.

**System status** reports on your database—document count, total chunks, memory usage, and search mode (hybrid or vector-only). Helpful for monitoring performance or debugging issues.

All of this uses:
- **LanceDB** for vector storage (file-based, no server needed)
- **Transformers.js** for embeddings (runs in Node.js, no Python)
- **all-MiniLM-L6-v2** model (384 dimensions, good balance of speed and accuracy)
- **RecursiveCharacterTextSplitter** for intelligent text chunking
- **Hybrid Search** combining BM25 (keyword) + vector (semantic) search

The result: query responses typically under 3 seconds on a standard laptop, even with thousands of document chunks indexed.

## First Run

The server starts instantly, but the embedding model downloads **on first use** (when you ingest or search for the first time):
- **Download size**: ~90MB (model files)
- **Disk usage after caching**: ~120MB (includes ONNX runtime cache)
- **Time**: 1-2 minutes on a decent connection
- **First operation delay**: Your initial ingest or search request will wait for the model download to complete

You'll see a message like "Initializing model (downloading ~90MB, may take 1-2 minutes)..." in the console. The model caches in `CACHE_DIR` (default: `./models/`) for offline use.

**Why lazy initialization?** This approach allows the server to start immediately without upfront model loading. You only download when actually needed, making the server more responsive for quick status checks or file management operations.

**Offline Mode**: After first download, works completely offline—no internet required.

## Security

**Path Restriction**: This server only accesses files within your `BASE_DIR`. Any attempt to access files outside this directory (e.g., via `../` path traversal) will be rejected.

**Local Only**: All processing happens on your machine. No network requests are made after the initial model download.

**Model Verification**: The embedding model downloads from HuggingFace's official repository (`Xenova/all-MiniLM-L6-v2`). Verify integrity by checking the [official model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

## Configuration

The server works out of the box with sensible defaults, but you can customize it through environment variables.

### For Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
DB_PATH = "./lancedb"
CACHE_DIR = "./models"
```

Supports PDF, DOCX, TXT, and Markdown. The server extracts text, splits it into chunks, generates embeddings locally, and stores everything in a local vector database.

Re-ingesting the same file replaces the old version automatically.

### Searching Documents

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
"Search for error handling best practices"
```

The hybrid search combines keyword matching (BM25) with semantic search. This means `useEffect` finds documents containing that exact term, not just semantically similar React concepts.

Results include text content, source file, and relevance score. Adjust result count with `limit` (1-20, default 10). Use `offset` (0-1000) for pagination through large result sets.

### Managing Files

```
"List all ingested files"          # See what's indexed
"Delete old-spec.pdf from RAG"     # Remove a file
"Show RAG server status"           # Check system health
```

## Search Tuning

Adjust these for your use case:

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Keyword vs semantic balance. Higher = more exact matching. |
| `RAG_GROUPING` | (not set) | `similar` for top group only, `related` for top 2 groups. |
| `RAG_MAX_DISTANCE` | (not set) | Filter out low-relevance results (e.g., `0.5`). |

Example (stricter, code-focused):
```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7",
  "RAG_GROUPING": "similar"
}
```

## How It Works

**TL;DR:**
- Documents are chunked intelligently (overlapping, boundary-aware)
- Each chunk is embedded locally using Transformers.js
- Search uses a weighted combination of BM25 + vector similarity
- Results are filtered based on relevance gaps, not raw scores

### Details

When you ingest a document, the parser extracts text based on file type (PDF via `pdf-parse`, DOCX via `mammoth`, text files directly).

The chunker splits text using LangChain's RecursiveCharacterTextSplitter—breaking on natural boundaries while keeping chunks around 512 characters with 100-character overlap.

Each chunk goes through the Transformers.js embedding model (`all-MiniLM-L6-v2`), converting text into 384-dimensional vectors. Vectors are stored in LanceDB, a file-based vector database requiring no server process.

When you search:
1. Your query becomes a vector using the same model
2. LanceDB performs both BM25 keyword search and vector similarity search
3. Results are combined (default: 60% keyword, 40% semantic)
4. Top matches return with original text and metadata

The keyword-heavy default works well for developer documentation where exact terms matter.

<details>
<summary><strong>Configuration</strong></summary>

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_DIR` | Current directory | Document root directory (security boundary) |
| `DB_PATH` | `./lancedb/` | Vector database location |
| `CACHE_DIR` | `./models/` | Model cache directory |
| `MODEL_NAME` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID ([available models](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction)) |
| `MAX_FILE_SIZE` | `104857600` (100MB) | Maximum file size in bytes |
| `CHUNK_SIZE` | `512` | Characters per chunk |
| `CHUNK_OVERLAP` | `100` | Overlap between chunks |

### Client-Specific Setup

**Cursor** — Global: `~/.cursor/mcp.json`, Project: `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/your/documents"
      }
    }
  }
}
```

**Codex** — `~/.codex/config.toml` (note: must use `mcp_servers` with underscore)

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

**Claude Code**:

```bash
claude mcp add local-rag --scope user \
  --env BASE_DIR=/path/to/your/documents \
  -- npx -y mcp-local-rag
```

### First Run

The embedding model (~90MB) downloads on first use. Takes 1-2 minutes, then works offline.

### Security

- **Path restriction**: Only files within `BASE_DIR` are accessible
- **Local only**: No network requests after model download
- **Model source**: Official HuggingFace repository ([verify here](https://huggingface.co/Xenova/all-MiniLM-L6-v2))

</details>

<details>
<summary><strong>Performance</strong></summary>

Tested on MacBook Pro M1 (16GB RAM), Node.js 22:

**Query Speed**: ~1.2 seconds for 10,000 chunks (p90 < 3s)

**Ingestion** (10MB PDF):
- PDF parsing: ~8s
- Chunking: ~2s
- Embedding: ~30s
- DB insertion: ~5s

**Memory**: ~200MB idle, ~800MB peak (50MB file ingestion)

**Concurrency**: Handles 5 parallel queries without degradation.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "No results found"

Documents must be ingested first. Run `"List all ingested files"` to verify.

### Model download failed

Check internet connection. If behind a proxy, configure network settings. The model can also be [downloaded manually](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

Default limit is 100MB. Split large files or increase `MAX_FILE_SIZE`.

### Slow queries

Check chunk count with `status`. Consider increasing `CHUNK_SIZE` to reduce the number of chunks (trade-off: larger chunks may reduce retrieval precision).

### "Path outside BASE_DIR"

Ensure file paths are within `BASE_DIR`. Use absolute paths.

### MCP client doesn't see tools

1. Verify config file syntax
2. Restart client completely (Cmd+Q on Mac for Cursor)
3. Test directly: `npx mcp-local-rag` should run without errors

</details>

<details>
<summary><strong>FAQ</strong></summary>

**Is this really private?**
Yes. After model download, nothing leaves your machine. Verify with network monitoring.

**Can I use this offline?**
Yes, after the first model download (~90MB).

**How does this compare to cloud RAG?**
Cloud services offer better accuracy at scale but require sending data externally. This trades some accuracy for complete privacy and zero runtime cost.

**What file formats are supported?**
PDF, DOCX, TXT, Markdown. Not yet: Excel, PowerPoint, images, HTML.

**Can I change the embedding model?**
Yes, but you must delete your database and re-ingest all documents. Different models produce incompatible vector dimensions.

**GPU acceleration?**
Transformers.js runs on CPU. GPU support is experimental. CPU performance is adequate for most use cases.

**Multi-user support?**
No. Designed for single-user, local access. Multi-user would require authentication/access control.

**How to backup?**
Copy `DB_PATH` directory (default: `./lancedb/`).

</details>

<details>
<summary><strong>Development</strong></summary>

### Building from Source

```bash
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
npm install
```

### Testing

```bash
npm test              # Run all tests
npm run test:coverage # With coverage
npm run test:watch    # Watch mode
```

### Code Quality

```bash
npm run type-check    # TypeScript check
npm run check:fix     # Lint and format
npm run check:deps    # Circular dependency check
npm run check:all     # Full quality check
```

### Project Structure

```
src/
  index.ts      # Entry point
  server/       # MCP tool handlers
  parser/       # PDF, DOCX, TXT, MD parsing
  chunker/      # Text splitting
  embedder/     # Transformers.js embeddings
  vectordb/     # LanceDB operations
  __tests__/    # Test suites
```

Each module has clear boundaries:
- **Parser** validates file paths and extracts text
- **Chunker** splits text into overlapping segments
- **Embedder** generates 384-dimensional vectors
- **VectorStore** handles all database operations
- **RAGServer** orchestrates everything and exposes MCP tools

## Performance

**Test Environment**: MacBook Pro M1 (16GB RAM), tested with v0.1.3 on Node.js 22 (January 2025)

**Query Performance**:
- Average: 1.2 seconds for 10,000 indexed chunks (5 results)
- Target: p90 < 3 seconds ✓

**Ingestion Speed** (10MB PDF):
- Total: ~45 seconds
  - PDF parsing: ~8 seconds (17%)
  - Text chunking: ~2 seconds (4%)
  - Embedding generation: ~30 seconds (67%)
  - Database insertion: ~5 seconds (11%)

**Memory Usage**:
- Baseline: ~200MB idle
- Peak: ~800MB when ingesting 50MB file
- Target: < 1GB ✓

**Concurrent Queries**: Handles 5 parallel queries without degradation. LanceDB's async API allows non-blocking operations.

**Note**: Your results will vary based on hardware, especially CPU speed (embeddings run on CPU, not GPU).

## Troubleshooting

### "No results found" when searching

**Cause**: Documents must be ingested before searching.

**Solution**:
1. First ingest documents: `"Ingest /path/to/document.pdf"`
2. Verify ingestion: `"List all ingested files"`
3. Then search: `"Search for [your query]"`

**Common mistake**: Trying to search immediately after configuration without ingesting any documents.

### "Model download failed"

The embedding model downloads from HuggingFace on first use (when you ingest or search for the first time). If you're behind a proxy or firewall, you might need to configure network settings.

**When it happens**: Your first ingest or search operation will trigger the download. If it fails, you'll see a detailed error message with troubleshooting guidance (network issues, disk space, cache corruption).

**What to do**: The error message provides specific recommendations. Common solutions:
1. Check your internet connection and retry the operation
2. Ensure you have sufficient disk space (~120MB needed)
3. If problems persist, delete the cache directory and try again

Alternatively, download the model manually:
1. Visit https://huggingface.co/Xenova/all-MiniLM-L6-v2
2. Download the model files
3. Set CACHE_DIR to where you saved them

### "File too large" error

Default limit is 100MB. For larger files:
- Split them into smaller documents
- Or increase MAX_FILE_SIZE in your config (be aware of memory usage)

### Slow query performance

If queries take longer than expected:
- Check how many chunks you have indexed (`status` command)
- Consider the hardware (embeddings are CPU-intensive)
- Try reducing CHUNK_SIZE to create fewer chunks

### "Path outside BASE_DIR" error

The server restricts file access to BASE_DIR for security. Make sure your file path is within that directory. Check for:
- Correct BASE_DIR setting in your MCP config
- Relative paths vs absolute paths
- Typos in the file path

### MCP client doesn't see the tools

**For Cursor:**
1. Open Settings → Features → Model Context Protocol
2. Verify the server configuration is saved
3. Restart Cursor completely
4. Check the MCP connection status in the status bar

**For Codex CLI:**
1. Check `~/.codex/config.toml` to verify the configuration
2. Ensure the section name is `[mcp_servers.local-rag]` (with underscore)
3. Test the server directly: `npx mcp-local-rag` should run without errors
4. Restart Codex CLI or IDE extension
5. Check for error messages when Codex starts

**For Claude Code:**
1. Run `claude mcp list` to see configured servers
2. Verify the server appears in the list
3. Check `~/.config/claude/mcp_config.json` for syntax errors
4. Test the server directly: `npx mcp-local-rag` should run without errors

**Common issues:**
- Invalid JSON syntax in config files
- Wrong file paths in BASE_DIR setting
- Server binary not found (try global install: `npm install -g mcp-local-rag`)
- Firewall blocking local communication

## How It Works

When you ingest a document, the parser extracts text based on the file type. PDFs use `pdf-parse`, DOCX uses `mammoth`, and text files are read directly.

The chunker then splits the text using LangChain's RecursiveCharacterTextSplitter. It tries to break on natural boundaries (paragraphs, sentences) while keeping chunks around 512 characters. Adjacent chunks overlap by 100 characters to preserve context.

Each chunk goes through the Transformers.js embedding model, which converts text into a 384-dimensional vector representing its semantic meaning. This happens in batches of 8 chunks at a time for efficiency.

Vectors are stored in LanceDB, a columnar vector database that works with local files. No server process, no complex setup. It's just a directory with data files.

When you search, your query becomes a vector using the same model. LanceDB finds the chunks with vectors most similar to your query vector (using cosine similarity). The top matches return to your MCP client with their original text and metadata.

The beauty of this approach: semantically similar text has similar vectors, even if the words are different. "authentication process" and "how users log in" will match each other, unlike keyword search.

## FAQ

**Is this really private?**

Yes. After the initial model download, nothing leaves your machine. You can verify with network monitoring tools—no outbound requests during ingestion or search.

**Can I use this offline?**

Yes, once the model is cached. The first run needs internet to download the model (~90MB), but after that, everything works offline.

**How does this compare to cloud RAG services?**

Cloud services (OpenAI, Pinecone, etc.) typically offer better accuracy and scale. But they require sending your documents externally, ongoing costs, and internet connectivity. This project trades some accuracy for complete privacy and zero runtime cost.

**What file formats are supported?**

Currently supported:
- **PDF**: `.pdf` (uses pdf-parse)
- **Microsoft Word**: `.docx` (uses mammoth, not `.doc`)
- **Plain Text**: `.txt`
- **Markdown**: `.md`, `.markdown`
- **Code Files**:
  - **TypeScript**: `.ts`, `.tsx`
  - **JavaScript**: `.js`, `.jsx`
  - **Python**: `.py`
  - **Java**: `.java`
  - **Go**: `.go`
  - **Rust**: `.rs`
  - **C/C++**: `.c`, `.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`
  - **Ruby**: `.rb`
  - **PHP**: `.php`
  - **C#**: `.cs`
  - **Shell**: `.sh`
  - **SQL**: `.sql`
- **Text Snippets**: Direct text ingestion via `memorize_text` tool (no file needed)

**Not yet supported**:
- Excel/CSV (`.xlsx`, `.csv`)
- PowerPoint (`.pptx`)
- Images with OCR (`.jpg`, `.png`)
- HTML (`.html`)
- Old Word documents (`.doc`)

Want support for another format? [Open an issue](https://github.com/shinpr/mcp-local-rag/issues/new) with your use case.

**Can I customize the embedding model?**

Yes, set MODEL_NAME to any Transformers.js-compatible model from HuggingFace. Keep in mind that different models have different vector dimensions, so you'll need to rebuild your database if you switch.

**How much does accuracy depend on the model?**

`all-MiniLM-L6-v2` is optimized for English and performs well for technical documentation. For other languages, consider multilingual models like `multilingual-e5-small`. For higher accuracy, try larger models—but expect slower processing.

**What about GPU acceleration?**

Transformers.js runs on CPU by default. GPU support is experimental and varies by platform. For most use cases, CPU performance is adequate (embeddings are reasonably fast even without GPU).

**Can multiple people share a database?**

The current design assumes single-user, local access. For multi-user scenarios, you'd need to implement authentication and access control—both out of scope for this project's privacy-first design.

**How do I back up my data?**

Copy your DB_PATH directory (default: `./lancedb/`). That's your entire vector database. Copy BASE_DIR for your original documents. Both are just files—no special export needed.

## Contributing

Contributions welcome. Before submitting a PR:

1. Run tests: `npm test`
2. Check quality: `npm run check:all`
3. Add tests for new features
4. Update docs if behavior changes

## License

MIT License. Free for personal and commercial use.

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic, [LanceDB](https://lancedb.com/), [Transformers.js](https://huggingface.co/docs/transformers.js), and [LangChain.js](https://js.langchain.com/).
