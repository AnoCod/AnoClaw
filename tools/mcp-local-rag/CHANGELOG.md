# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2025-12-27

### Fixed

- **Offset pagination**: The `offset` parameter in `query_documents` now works correctly for paginating through search results
- **Memory deletion**: The `delete_file` tool now accepts `memory://` paths to delete stored memories (e.g., `memory://my-snippet`)

### Added

- **Parameter validation**: Added comprehensive validation for `offset` (must be integer, 0-1000 range) and `limit` (must be integer, 1-20 range) parameters in `query_documents`
- **Memory label validation**: Memory labels in `memorize_text` must now contain only alphanumeric characters, hyphens, underscores, and dots

### Changed

- Updated tool schema descriptions to document parameter constraints and validation rules
