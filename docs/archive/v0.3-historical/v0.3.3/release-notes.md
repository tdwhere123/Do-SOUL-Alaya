# v0.3.3 Release Notes

v0.3.3 is a patch-internal quality release for recall graph behavior,
bootstrap reconciliation truth, doctor diagnostics, and keychain hygiene.

## Added

- `report_context_usage` now persists bounded `RECALLS` edges between
  recalled memory entries that were reported as used, and later recall
  can read those persisted graph edges as `graph_support`.
- Recall scoring reallocates graph/path weight to relevance when both
  graph support and path plasticity are cold for the candidate set.
- `alaya doctor` reports advisory `graph_health` counts and warnings
  for memory graph edges, path relations, and latest path events.
- Bootstrap reconciliation has an explicit `skipped_no_templates` state
  for daemon defaults that do not provide ontology seed templates.
- Keychain adapter coverage for masked TTY raw-mode restoration, macOS
  `security -i` quoting, Windows PasswordVault load-failure mapping, and
  platform override guardrails.

## Changed

- `defaultBootstrappingTemplates` is empty by default. The daemon no
  longer creates PathRelation rows merely to make a new workspace look
  non-empty.
- Zero-day policies stay in the runtime security-policy path
  (`ZERO_DAY_POLICIES_JSON` -> zero-day security layer) and are not
  encoded as object defaults or bootstrap PathRelation seeds.
- Bootstrap reconciliation skips archived workspaces during startup,
  distinguishes corrupt partial records from already-planted state, and
  degrades `doctor --reconcile-bootstrap` when reconciliation throws or
  detects corrupt partial state.
- Keychain `secret_ref` parsing is centralized, whitespace-sensitive,
  and resolved once per doctor pass.
- `install.ts` is split so the keychain flow and masked-stdin reader live
  in focused modules under `apps/core-daemon/src/cli/install/`.
- Windows PasswordVault WinRT load failures now report
  `keychain_tooling_unavailable` instead of looking like a missing entry.

## Compatibility

- No MCP tool surface change (no new MCP tool names, no removed
  request/response fields).
- Protocol zod schemas: additive only. `MemoryGraphEdgeTypeSchema`
  gains a new enum value `"recalls"`
  (`packages/protocol/src/soul/memory-graph.ts`), which is the
  RECALLS-edge marker persisted by used recall reports.
- EventLog payload schemas: additive only. The same `"recalls"`
  enum value is now a valid `edge_type` in
  `SoulGraphEdgeCreatedPayloadSchema`
  (`packages/protocol/src/events/graph-auditor.ts`); a new
  `soul.graph.edge_created` row is now emitted on each persisted
  RECALLS edge. No existing payload field is removed or renamed.
- No runtime config schema change.
- No SQLite migration (`memory_graph_edges` table already existed
  before v0.3.3; v0.3.3 only adds a new `edge_type` value).
- Per invariants §25, additive enum values are additive changes; in
  a publicly released line they would warrant a minor bump
  (0.3.x → 0.4.0). v0.3.3 is unreleased and the workspace bumped
  0.3.2 → 0.3.3 locally for binary-version alignment only — see
  `chore(v0.3.3): bump workspace packages to 0.3.3` (commit
  `e77668c`). The next public release should reconsider whether
  the v0.3.0 → v0.3.3 delta deserves a 0.4.0 stamp.
- Operators with persisted invalid keychain refs should repair their
  config by re-running `alaya install --keychain` or editing the local
  runtime config before relying on doctor/runtime startup.
- PowerShell policy-driven transcription can capture stdout outside
  Alaya's control; operators should not enable transcript capture for
  secret-reading sessions.

## Verification

See `reports/v0.3.3-closeout.md` for final command evidence.
