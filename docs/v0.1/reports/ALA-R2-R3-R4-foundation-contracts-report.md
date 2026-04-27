# ALA-R2/R3/R4 Foundation Contracts Report

Status: closed for ALA-R2/R3/R4 foundation contracts on 2026-04-27.

This report covers:

- [ALA-R2 - Ontology And Evidence](../task-cards/ontology-and-evidence.md)
- [ALA-R3 - Structure Registry And Paths](../task-cards/structure-registry-and-paths.md)
- [ALA-R4 - Governance And Promotion](../task-cards/governance-and-promotion.md)

It closes only the foundation contract slice. It does not close MCP,
Attach/Profile, Gateway, recall/provider, Inspector, benchmark, daemon runtime,
or full product readiness.

## Scope Delivered

| Card | Delivered surface |
|---|---|
| ALA-R2 | `src/ontology/**` defines Alaya-owned `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` contracts and validators. Runtime-owned create operations require audit source/evidence, usable evidence refs, and source object refs where applicable. |
| ALA-R3 | `src/structure/**` defines durable `PathRelation`, runtime-only `ActivationCandidate`, deterministic manifestation resolution, and read-only topology projection. |
| ALA-R4 | `src/governance/**` defines promotion outcomes, HITL/operator reason policy, and blocking fail-closed bypass signals. |
| Storage | `src/storage/sqlite.ts` applies ordered migrations `002-ontology`, `003-structure`, and `004-governance` after the R1 baseline migration. Storage remains internal. |
| Runtime/API | `AlayaRuntimePort` exposes runtime-owned ontology, structure, manifestation, and governance operations; internal storage repos and callback mutation helper remain unexported. |
| Doctor/status | Doctor now reports `foundation_contracts_ready: true` while keeping `product_ready: false` and profile/provider `not_implemented`. |

## Non-Goals Preserved

- Did not restore old prototype source.
- Did not import `@do-what/*` or `do-what-new/packages/*` runtime code.
- Did not add `zod` or any new runtime dependency.
- Did not implement MCP, CLI protocol fallback, Attach/Profile, Gateway,
  recall/provider, Inspector, benchmark, daemon runtime, or agent usage proof.
- Did not expose storage as the adapter-facing API.

## Verification Evidence

| Check | Command | Result |
|---|---|---|
| Build | `rtk pnpm build` | passed. |
| Tests | `rtk pnpm test` | passed; 8 files, 39 tests. |
| Doctor smoke | `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-r234-smoke` | passed; JSON reported `foundation_contracts_ready: true`, package/runtime/storage/ontology/structure/governance `ok`, profile/provider `not_implemented`, and `product_ready: false`. |
| Forbidden import scan | `rtk rg -n "@do-what/\|do-what-new/packages" package.json src` | no matches; command exited 1 because ripgrep found no matches. |
| Whitespace check | `rtk git diff --check` | passed. |

`node:sqlite` emitted Node's experimental warning during the CLI smoke. The
doctor JSON itself was stable on stdout; the warning does not claim product
readiness and remains an explicit dependency tradeoff.

## Test Coverage

- `src/__tests__/ontology-runtime.test.ts`: evidence creation, memory creation,
  auditable missing-ref reject, broken evidence reject, and claim source-ref
  bypass rejection.
- `src/__tests__/structure.test.ts`: full PathRelation group validation,
  runtime-only ActivationCandidate shape, manifestation budget/governance/task
  coupling behavior, runtime-owned path lookups, strict-governance rejection,
  and read-only topology derivation.
- `src/__tests__/governance.test.ts`: promotion outcome matrix, hazard
  pending-review behavior, operator reason/HITL policy, runtime source/evidence
  ref gates, persisted HITL proof, and bypass fail-closed signal.
- Existing R1 tests continue to cover audit ordering, storage idempotency,
  atomic rollback when committed audit append fails, actor/payload redaction,
  doctor JSON, public API boundary, and runtime decision validation.

## Review Status

Closed after parent implementation review, targeted four-lens review, fix-loop,
and verification. Review fixes tightened committed-audit atomicity, governance
source/evidence resolution, persisted HITL proof, strict path governance, active
path lookup semantics, and audit actor redaction.

Residual non-goals remain explicit: this slice establishes foundation contracts
only. Recall/provider, adapter activation, session usage proof, Inspector, and
benchmark work still belong to later cards.
