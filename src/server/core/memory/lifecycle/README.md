# MemoryLifecycle

Post-session memory lifecycle management for the AnoClaw memory system. Handles
semantic extraction, Ebbinghaus-decay-based pruning, and consolidation group
detection.

Invoked from `AgentLoop` after completion and on session close.

## Features

- **Ebbinghaus decay** — exponential forgetting curve with configurable half-life per memory type.
- **4-tier pruning** — active, warm, cold, archive tiers based on computed strength.
- **Consolidation detection** — Jaccard-similarity-based grouping of similar memories.
- **Auto-extraction trigger** — calls `MemoryManager.autoExtract()` on session close.
- **Fire-and-forget** — never throws; errors are logged and swallowed.

## Constants

### Half-life per memory type

| Type | Half-life |
|---|---|
| `user` | 365 days |
| `project` | 90 days |
| `reference` | 30 days |
| `feedback` | 14 days |

### Quantization tiers

| Tier | Min strength | Policy |
|---|---|---|
| `active` | 0.3 | Kept in active storage |
| `warm` | 0.1 | Kept in active storage |
| `cold` | 0.05 | Kept in active storage |
| `archive` | 0 | Pruned on session close |

## Public API

### `computeMemoryStrength(entry, now?): number`

Compute a 0–1 memory strength score from access patterns and time elapsed.

Formula:
```
decay = e^(-hours_since_access * ln(2) / half_life)
freqBoost = min(0.15, log2(1 + accessCount) / 10)
strength = min(1, importance * decay + freqBoost)
```

```ts
const strength = computeMemoryStrength(entry);
// 0.0 to 1.0
```

### `getQuantizationTier(strength: number): string`

Map a strength score to a tier name: `'active'`, `'warm'`, `'cold'`, or `'archive'`.

```ts
const tier = getQuantizationTier(0.25);
// 'warm'
```

### `findConsolidationGroups(entries, threshold?): MemoryEntry[][]`

Find groups of similar memories that should be consolidated. Uses Jaccard
similarity on tokenized content. Only groups entries of the same `type`.
Returns groups with at least 2 entries above the threshold.

Default threshold: 0.85.

```ts
const groups = findConsolidationGroups(agentEntries, 0.80);
// groups: [[entryA, entryB], [entryC, entryD, entryE]]
if (groups.length > 0) {
  // LLM consolidation deferred to next session
}
```

### `runSessionCloseLifecycle(agentId, sessionId, messages): Promise<void>`

Run the full post-session lifecycle:

1. **Auto-extract** facts from assistant messages via `MemoryManager.autoExtract()`
2. **Decay and prune** all agent+team memories — entries that decay to `archive`
   tier are deleted via `MemoryManager.remove()`
3. **Detect consolidation groups** — reports groups found but defers LLM-powered
   merging to Phase 2

```ts
await runSessionCloseLifecycle('agent-42', 'session-abc', conversationMessages);
```

## How AgentRuntime hooks into it

`AgentLoop` calls `runSessionCloseLifecycle()` in its completion path
(non-blocking, fire-and-forget):

```ts
// In AgentLoop, after the final assistant message:
runSessionCloseLifecycle(agentId, sessionId, messages).catch(() => {});
```

This creates an in-memory only integration — the lifecycle never blocks the loop
or requires additional routes. The lifecycle reads from `MemoryManager` (which
tries MemoryDatabase v2 first, falls back to filesystem) and writes deletions
back through the same `MemoryManager.remove()` path.

## Usage example

```ts
import {
  computeMemoryStrength,
  getQuantizationTier,
  findConsolidationGroups,
  runSessionCloseLifecycle,
} from './lifecycle/MemoryLifecycle.js';

// Manual strength check
const entries = await memoryManager.search(agentId, MemoryScope.Agent, '');
for (const entry of entries) {
  const strength = computeMemoryStrength(entry);
  const tier = getQuantizationTier(strength);
  console.log(`${entry.name}: ${tier} (${strength.toFixed(2)})`);
}

// Find consolidation candidates
const groups = findConsolidationGroups(entries);
console.log(`Found ${groups.length} consolidation groups`);

// Full lifecycle (automatic)
await runSessionCloseLifecycle(agentId, sessionId, messages);
```
