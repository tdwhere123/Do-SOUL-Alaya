# ALA-R5/R6/R7 Runtime Use Proof Report

Status: locally verified after review-fix loop for ALA-R5/R6/R7 runtime use
proof contracts on 2026-04-28; pending final post-fix review acceptance.

This report covers:

- [ALA-R5 - Recall And Context Assembly](../task-cards/recall-and-context.md)
- [ALA-R6 - Provider And Agent-Assisted Proposal](../task-cards/provider-and-agent-proposal.md)
- [ALA-R7 - Session Audit And Trust](../task-cards/session-audit-and-trust.md)

It documents only the runtime use proof contract slice. It does not complete
MCP, Attach/Profile, Gateway, real external provider adapters, Inspector,
benchmark, daemon runtime, or full product readiness.

## Scope Delivered

| Card | Delivered surface |
|---|---|
| ALA-R5 | `src/recall/**` defines structured/lexical/path-aware recall merge, opt-in embedding supplement degradation, runtime-only context packs, exclusions, source-plane metadata, and data-not-instructions delivery text. Runtime context assembly prefilters through storage lexical/FTS search, treats caller-supplied records only as persisted object hints that cannot suppress storage recall, applies explicit runtime-owned memory visibility governance before inclusion, and makes context-pack retry replay idempotent or conflict-failed. |
| ALA-R6 | `src/provider/**` defines provider capability selection, deterministic priority/tie-break behavior, provider health/degradation states, proposal-only validation, rejected proposal normalization, and background proposal job summaries. Runtime proposal recording namespaces provider decisions by workspace, checks provider selection replay scope, rejects workspace scope mismatches, validates provider-decision capability/source lineage, and compares raw canonical proposal replay fingerprints instead of redacted display payloads. |
| ALA-R7 | `src/session/**` defines session lifecycle records, context delivery records, usage proof records, trust summary derivation, delivered-is-not-used semantics, deterministic late terminal handling, duplicate event-id conflict detection, and trust summary evidence/source/proof lineage. Runtime delivered events must match the persisted context pack's complete included memory set, usage proof memory IDs must be included in the persisted pack, proposal-record lineage is validated before persistence, and trust summaries are scoped to `session_id + workspace_id + run_id` with idempotent replay fingerprints. |
| Storage | `src/storage/sqlite.ts` applies ordered migrations `005-recall-context`, `006-provider-proposal`, `007-session-trust`, and `008-runtime-use-proof-lineage-replay` after the R1-R4 migrations. Storage remains internal. |
| Runtime/API | `AlayaRuntimePort` exposes runtime-owned context assembly, context pack recording, memory visibility governance, provider selection, proposal recording, session event recording, and trust summary generation. |
| Doctor/status | Doctor now reports `runtime_use_proof_ready: true` while keeping `product_ready: false` and Attach/Profile `not_implemented`. |

## Non-Goals Preserved

- Did not restore old prototype source.
- Did not import `@do-what/*` or `do-what-new/packages/*` runtime code.
- Did not add a concrete OpenAI, Anthropic, local model, or other provider SDK adapter.
- Did not implement MCP, CLI protocol fallback, Attach/Profile, Gateway,
  Inspector, benchmark, daemon runtime, or full product readiness.
- Did not treat a context pack as durable truth or as usage proof.
- Did not allow provider/agent output to directly materialize durable memory.

## Verification Evidence

| Check | Command | Result |
|---|---|---|
| R5 targeted tests | `rtk pnpm exec vitest run src/__tests__/recall-context.test.ts` | passed. |
| R6 targeted tests | `rtk pnpm exec vitest run src/__tests__/provider-proposal.test.ts` | passed. |
| R7 targeted tests | `rtk pnpm exec vitest run src/__tests__/session-trust.test.ts` | passed; review fix added conflicting duplicate-event-id coverage. |
| Runtime integration | `rtk pnpm exec vitest run src/__tests__/runtime-use-proof.test.ts` | passed; review fix added FTS-backed recall, runtime-owned governance visibility, visibility workspace/ref checks, supplied-record persistence checks, provider lineage/scope, provider selection replay scope, raw proposal replay fingerprints, exact delivered context-pack memory-set checks, proposal-recorded lineage checks, context-pack/trust-summary retry idempotency, session replay, unredacted trust identifiers, and trust-summary mismatch coverage. |
| Doctor/status regression | `rtk pnpm exec vitest run src/__tests__/doctor-cli.test.ts src/__tests__/runtime-use-proof.test.ts` | passed. |
| Full test suite | `rtk pnpm test` | passed after latest review-fix loop: 12 files, 68 tests. |
| Build | `rtk pnpm build` | passed after latest review-fix loop. |
| Storage migration regression | `rtk pnpm exec vitest run src/__tests__/storage.test.ts` | passed after adding `005` through `008`. |
| Doctor smoke | `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-r567-reviewloop4` | passed; `runtime_use_proof_ready: true`, `product_ready: false`, migrations `001` through `008`. |
| Package dry-run | `rtk env NPM_CONFIG_CACHE=/tmp/do-soul-alaya-npm-cache npm pack --dry-run --json` | passed; package contents exclude compiled `dist/__tests__` helper artifacts. |
| Forbidden runtime import scan | `rtk rg -n "@do-what/|do-what-new/packages" package.json src` | no matches. |
| Whitespace check | `rtk git diff --check` | passed. |

## Test Coverage

- `src/__tests__/recall-context.test.ts`: deterministic lexical ranking, short-token/CJK matching, tombstone/scope/governance exclusion, path additive recall, embedding degradation/supplement, context pack metadata, and data-not-instructions delivery text.
- `src/__tests__/provider-proposal.test.ts`: deterministic provider selection, required fail-closed behavior, optional degradation, provider-disabled handling, proposal rejection, durable bypass rejection, and background failure isolation.
- `src/__tests__/session-trust.test.ts`: seven trust states, delivered-only not used, explicit/accepted proof, weak proof, auditable delivery/proof validation, trust summary source/evidence/proof lineage, replay stability, duplicate event-id conflict rejection, late terminal handling, and proof-after-terminal markers.
- `src/__tests__/runtime-use-proof.test.ts`: runtime-owned FTS-backed context assembly, persisted governance visibility, visibility workspace/ref rejection, supplied recall-record persistence and non-suppression, provider decision/proposal records, provider decision lineage, provider selection replay safety, raw proposal replay safety, proposal scope rejection, exact delivered context-pack memory-set checks, proposal-recorded lineage checks, context-pack and trust-summary idempotent retry, session event replay, unredacted trust identifiers, scoped trust summary generation, and trust summary mismatch rejection.

## Review Status

Pending final post-fix review acceptance after parent integration, targeted
verification, and review/fix-loop. Residual non-goals remain explicit: this
slice establishes runtime use proof contracts only. MCP/CLI adapter activation,
Attach/Profile, Gateway, real external provider adapters, Inspector, benchmark,
and full product gate remain later cards.
