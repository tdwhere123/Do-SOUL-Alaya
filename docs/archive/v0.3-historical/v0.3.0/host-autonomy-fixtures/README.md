# Host Autonomy Fixtures (#BL-038)

These fixtures are **snapshots of real attached-host usage**, not synthetic
capture sessions. The Alaya operator's normal machine is the test environment:
every time Codex or Claude Code attaches over MCP and has a recall-worthy
conversation, the daemon writes a `soul.recall.delivered` row and — when the
host reports the recalled context used — a matching
`soul.context_usage.reported` row with `usage_state == "used"`. That linked
chain *is* the #BL-038 witness; it is more authentic than a scripted capture
because it is the host genuinely choosing to call `soul.recall` /
`soul.report_context_usage` during real work.

## What a fixture directory contains

`<host>-live/` (produced by `scripts/export-host-autonomy-witness.mjs`):

- `event-log.jsonl` — the `soul.recall.delivered` + `soul.context_usage.reported`
  rows for each complete chain, sorted by `created_at`. Structured fields only
  (delivery / session / run ids, `agent_target`, `query_hash`, `pointer_count`,
  `latency_ms`, `usage_state`, `workspace_id`); no recalled content, no
  free-text fields.
- `metadata.json` — `capture_kind: "live-usage-witness"`, daemon version,
  source DB path, capture timestamp, chain count, the `agent_target` values
  present, and the delivery ids.

`apps/core-daemon/src/__tests__/host-autonomy-witness.test.ts` reads the fixture
and asserts the chain shape (recall delivered with `pointer_count >= 1`, a
matching `usage_state == "used"` report, linked by `delivery_id`, host-typed
`agent_target`, usage not preceding delivery). It runs offline; no live host is
needed at test time.

## Refreshing

```
node scripts/export-host-autonomy-witness.mjs [db-path] [host-label]
```

Defaults: `db-path` = `$ALAYA_CONFIG_DIR/alaya.db` or `~/.config/alaya/alaya.db`;
`host-label` = `claude-code`. Re-running overwrites `<host-label>-live/` with the
current EventLog state.

`agent_target = "mcp"` rows are the generic attached-host bucket used before the
v0.3.0 attach env stamp (`ALAYA_AGENT_TARGET`); after `alaya attach claude` /
`alaya attach codex` is re-run on a v0.3.0 daemon, fresh rows are labelled
`claude-code` / `codex`. Either way the row came from a real CLI host — the
daemon has no synthetic-host code path to these targets — so the witness is
valid; relabelled rows are just sharper attribution.

## Why not a stdio replay fixture

An earlier plan called for a `transcript.jsonl` of raw MCP stdio frames plus an
offline *replay* that re-derives the EventLog rows. The daemon does not record
raw stdio frames in production, and a synthetic transcript would be exactly the
kind of fabricated proof #BL-038 rejects. The live-usage witness keeps the
"real host, real conversation" bar while being something the operator actually
has — so v0.3.0 closes #BL-038 with this witness rather than carrying it
forward.
