# Alaya v0.2.0 Release Notes

v0.2.0 is the first forward-development release after the v0.1 port:
pi-mono provider wiring, recall scoring refinements, Trustworthy Loop
trace anchoring, and invariant §25 for public protocol SemVer. Local
deterministic build/test gates pass and the credentialed live pi-mono
smoke is recorded in `task-cards/reports/v0.2.0-slice-3.md`.

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
  the current public surface, including schema signature hashes for
  optionality, nullability, enum/literal values, defaults, and basic
  checks, so additions and removals are explicit.

## Follow-Ups

- `#BL-009` remains deferred to v0.2.1 for OS keychain secret refs.
- `#BL-037` and `#BL-038` remain deferred to v0.2.2 for host slash
  recognition and real-host autonomous use proof.
