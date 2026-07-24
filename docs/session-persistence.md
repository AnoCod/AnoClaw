# Session persistence and restart recovery

Session data is rooted exclusively at the absolute directory passed to
`SessionManager.initialize()`. `JsonlStore` does not derive paths from the
process working directory.

Each active session directory contains:

- `meta.json` and `meta.json.bak`: versioned lifecycle metadata and derived
  `headEventUuid`, logical `messageCount`, and physical `eventCount`.
- `shard_NNNNNN.jsonl` plus `shards.json`: the legacy/default append-only
  transcript layout.
- `append-transaction.json`: a short-lived batch commit record. A pending
  record is rolled back on recovery; a committed record is retained and its
  metadata is reconciled.
- `active-history.json` and `.history/<generation>/`: generation-based
  transcript replacement used by compaction. The manifest switches only after
  the new generation is fully written and synced.

At startup, lifecycle metadata and transcript structure are validated. A torn
tail in the final shard is repaired; corruption in committed lines or an
invalid session tree is not ignored. Invalid directories are moved to
`_quarantine/<timestamp>/` and recorded in `_quarantine/audit.jsonl`. Recovery
never deletes quarantined bytes.

Run a read-only audit before starting the application or before deciding what
to restore manually:

```powershell
npm run sessions:audit
npm run sessions:audit -- --root D:\ANOCLAW\data\sessions
```

The command emits JSON and never changes session data. `valid` entries can be
loaded directly, `repairable` entries need only normal cold-start tail repair,
and `invalid` entries require manual inspection. Restore a quarantined
directory only after correcting its metadata/transcript and ensuring its
directory name exactly matches `sessionId`.

Restart checkpoints use `restartId` as an idempotency key. The recovery system
message ID is `restart-<restartId>`; a repeated startup deletes a successfully
handled checkpoint without appending the message again. Invalid targets are
retained as timestamped failed checkpoints for diagnosis.
