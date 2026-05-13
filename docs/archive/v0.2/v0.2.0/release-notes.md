# Alaya v0.2.0 Release Notes

v0.2.0 is the first forward-development candidate after the v0.1 port:
pi-mono provider wiring, recall scoring refinements, Trustworthy Loop
trace anchoring, and invariant §25 for public protocol SemVer. Local
deterministic build/test gates pass and the credentialed
provider-transport smoke is recorded in
`task-cards/reports/v0.2.0-slice-3.md`; full release acceptance still
requires the Slice 3 AC7 daemon/EventLog live smoke.

## Release Channel

v0.2.0 follows the GitHub source tarball / local build distribution
path. Workspace package versions support local source consumers and
SemVer pinning; npm registry publication and global `npm install` are
not claimed release channels for v0.2.0.

## Provider Path

- `OfficialApiGardenProvider` now delegates official-provider text
  completion to `@earendil-works/pi-ai` through
  `packages/soul/src/garden/pi-mono-extractor.ts`.
- Prompt text, JSON parsing, confidence clamping, and candidate signal
  construction stay in `packages/soul/src/garden/compute-provider.ts`
  so provider transport drift is isolated from extraction semantics.
- `apps/core-daemon/src/services/garden-compute-provider-resolver.ts`
  lazily resolves the current `RuntimeGardenComputeConfig.secret_ref`,
  rebuilds official providers after config or secret changes, and is
  reinserted into compute routing after runtime Garden compute PATCH.
  Its `provider_kind` mirrors the provider it actually resolved (so it
  does not advertise `OFFICIAL_API` while serving the local-heuristics
  fallback), and `ConversationService` re-resolves the current default
  routing candidate when a stale model ref does not match — both follow
  a hot config PATCH without a daemon restart.
- The unused post-`ConversationProvider`-retirement stance/routing code
  (`compute-routing-resolver.ts`, `stance-resolution-service.ts`,
  `createStancePolicyProvider`) was removed; none had a production
  caller.
- `parseOfficialApiSignals` and the pi-mono extractor bound the
  official-provider response: at most 64 signals, length-clamped
  `object_kind` / `matched_text` / `reason`, and a response body over
  256 000 chars is rejected as invalid JSON — Garden's fire-and-forget
  per-turn call cannot amplify a hostile/misconfigured endpoint into
  unbounded EventLog writes.
- The runtime Garden-compute config-change audit
  (`SOUL_HEALTH_JOURNAL_RECORDED` → `change_summary`) records the new
  non-secret `provider_url` and `model_id` values (additive optional
  fields), not just the changed field names; `secret_ref` stays reduced
  to `secret_ref_kind`.
- The old engine-gateway `ConversationProvider` placeholder and
  `resolveLanguageModel` throw path were deleted. This removal is
  outside the invariant §25 public surface: it was a workspace-internal
  TypeScript placeholder with no MCP, EventLog, runtime-config, or
  production-consumer contract.

## Recall Refinement

- `BudgetSnapshot.pressure_ratio` is additive and defaulted for old
  payloads; SOFT budget penalty now follows a graduated pressure curve
  instead of a fixed constant.
- `soul.recall` accepts an optional `host_context.tokenizer_hint`, and
  recall/context-lens token estimation uses a per-call estimator. (The
  schema carries `tokenizer_hint` only — an unused `host_context_window`
  field that briefly existed pre-release was dropped.)
- `RecallPolicy.domain_weight_overrides` can override activation
  weights by deterministic domain-tag match; recall results expose
  `RecallScoreFactors.resolved_activation_weights` for auditability.

## Post-v0.2.0 Addendum: Self-Bootstrapping Capture

This section documents v0.2.x self-bootstrapping capture work that
landed after the v0.2.0 review baseline. It is not part of the v0.2.0
candidate surface or its release-acceptance evidence.

- Durable capture no longer depends on the host filing
  `soul.emit_candidate_signal` / `soul.propose_memory_update` or on it
  echoing a `turn_digest` on `soul.report_context_usage`. `soul.recall`
  gains an optional `recent_turn` (the verbatim latest user message;
  falls back to `query`) and, after recording the delivery, enqueues a
  `POST_TURN_EXTRACT` Garden task from that text — deduped by
  `(workspace_id, run_id, turn-text hash)`, skipped below a 24-char
  floor or when the librarian queue is already 128 deep. Attached MCP
  stdio sessions without `ALAYA_RUN_ID` are first canonicalized as
  session runs, so passive extraction still satisfies the durable
  `run_id` contract. Garden's existing pipeline (`LocalHeuristics` →
  deterministic triage → materialization) turns those signals into
  durable memory.
- `report_context_usage` no longer gates its `POST_TURN_EXTRACT` enqueue
  on a used object — a cold-store turn carrying a `turn_digest` is still
  worth extracting. Report-side extraction and recall-hit promotion now
  attribute side effects to the linked delivery's workspace / run / agent,
  so delayed retries or CLI fallback reports do not persist under the
  reporter's later session. Tier-promote stays separate (nothing to
  promote when no recalled object was used).
- Recall-origin tasks are keyed on the turn-text hash and report-origin
  tasks are keyed on `turn_index`, but the report path suppresses enqueue
  when the same normalized user turn already has a recall-origin extract
  task. Garden's `MERGE_PROPOSAL` consolidation remains the downstream
  duplicate guard for distinct turns or genuinely different task inputs.
- A `POST_TURN_EXTRACT` task that fails during extraction (provider
  error, bad response) is recorded as failed and no longer rethrows: the
  task now runs on every recall, so a flaky compute provider must not
  abort the rest of the Garden background pass.
- Host-worker `garden.complete_task` now records an immutable completion
  envelope before candidate-signal persistence. If a partial completion
  fails after signals were persisted, retries must submit the same
  `candidate_signals` envelope; shortened, extended, or changed retries
  are rejected so the completion audit cannot under-report durable
  signal side effects.
- Accepted signals enter the persisted `compiled` state before
  materialization side effects run. Replaying a `triaged` / `compiled`
  signal no longer reruns materialization, which prevents duplicate
  evidence / memory / claim objects after a crash or retry in the narrow
  window between side effects and final state update.
- The `soul.recall` / `soul.report_context_usage` tool descriptions and
  the MCP server instructions tell the host to forward turn text so the
  plane learns passively, and reframe emit/propose as the optional
  explicit channel for facts the host judges clearly worth recording.
- In the current worktree this post-baseline addition also moves the
  SemVer snapshots: `soul.recall.recent_turn` is an additive optional
  MCP field, and the tool-description hashes move for `soul.recall` and
  `soul.report_context_usage`. Treat those changes as v0.2.x
  self-bootstrapping evidence, not v0.2.0 candidate evidence.
- `alaya doctor` reports where recall-driven extract tasks run
  (`recall-driven extraction: in-process via <provider>` or
  `queued for an attached host worker`), so "memory is not being
  captured" is diagnosable from doctor alone.

## Trustworthy Loop Trace

- Agent-originated signal and proposal paths carry optional
  `source_delivery_ids` arrays from MCP request to EventLog payload and
  proposal persistence after the daemon validates each anchor against a
  recorded recall delivery in the current trusted context.
- Garden-originated candidate signals remain anchor-free by design; the
  request schema and Garden result content schema stay split so Garden
  workers cannot smuggle recall anchors.
- The daemon integration proof for the loop uses EventLog payload data
  and SQLite JSON membership over `source_delivery_ids`.
- `source_delivery_ids` arrays are bounded to at most 32 anchors so a
  single MCP call cannot fan out into an unbounded delivery-lookup
  sequence.

## CLI

- `alaya inspect` auto-selects the workspace whose registered
  `repo_path` resolves to the current directory when several workspaces
  are active; it still lists candidates and asks for `--workspace <id>`
  when zero or more than one match.

## SemVer Contract

- `docs/handbook/invariants.md` now defines invariant §25: MCP tool
  names/descriptions plus transitively reachable MCP schemas, EventLog
  payload schemas, and runtime control-plane config schemas are
  SemVer-covered public contracts.
- `docs/handbook/maintenance.md` now owns future public-symbol
  deprecation entries. No public symbols are deprecated as of v0.2.0.
- `packages/protocol/src/__tests__/semver-surface.test.ts` snapshots
  the schema / EventLog / runtime-config surface, including schema
  signature hashes for optionality, nullability, enum/literal values,
  defaults, and basic checks, so additions and removals are explicit.
- `packages/engine-gateway/src/__tests__/semver-tool-surface.test.ts`
  snapshots MCP tool names and description hashes from the actual
  exported `soulToolDefs`, keeping provider-facing tool text pinned
  without making `packages/protocol` parse or import a sibling package.

## Follow-Ups

- `#BL-009` remains deferred to v0.2.1 for OS keychain secret refs.
- `#BL-037` and `#BL-038` remain deferred to v0.2.2 for host slash
  recognition and real-host autonomous use proof.
- No additional v0.2.0 review-fix backlog was opened; task-card tail
  items are either current non-goals or conditional future work that
  requires explicit scheduling.
