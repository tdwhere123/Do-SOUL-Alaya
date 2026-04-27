# ALA-R12 - Full Product Gate

## Goal

验证 Do-SOUL Alaya 完整产品闭环：
install -> configure -> activate -> recall -> use -> propose -> govern ->
export/backup -> benchmark -> final review。

This card aggregates ALA-R1 through ALA-R11 only. It does not add new product
features, new defaults, or a visual Inspector blocker。

## Source References

- `docs/v0.1/full-product-loop.md` - Alaya end-to-end product loop and v0.1
  closeout expectations。
- `docs/v0.1/task-cards/runtime-truth-kernel.md` - ALA-R1 runtime/API/audit
  write/doctor root。
- `docs/v0.1/task-cards/ontology-and-evidence.md` - ALA-R2 Memory Ontology and
  Evidence。
- `docs/v0.1/task-cards/structure-registry-and-paths.md` - ALA-R3
  PathRelation, ActivationCandidate, manifestation。
- `docs/v0.1/task-cards/governance-and-promotion.md` - ALA-R4 Promotion Gate,
  HITL, governance audit。
- `docs/v0.1/task-cards/recall-and-context.md` - ALA-R5 recall and context
  assembly。
- `docs/v0.1/task-cards/provider-and-agent-proposal.md` - ALA-R6 provider
  capability and agent-assisted proposal。
- `docs/v0.1/task-cards/session-audit-and-trust.md` - ALA-R7 session audit and
  trust states。
- `docs/v0.1/task-cards/agent-integration.md` - ALA-R8 MCP-first, CLI fallback,
  Attach/Profile, Gateway。
- `docs/v0.1/task-cards/operations-and-portability.md` - ALA-R9 operations and
  portability。
- `docs/v0.1/task-cards/evaluation-and-benchmark.md` - ALA-R10 evaluation and
  benchmark。
- `docs/v0.1/task-cards/graph-inspector-contract.md` - ALA-R11 Phase 2 graph
  contract readiness。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/workflow/review-protocol.md` -
  source-backed review/fix-loop discipline。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:44`
  - verification evidence section style。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/reports/independent-rereview-2026-04-24.md:284`
  - independent review gate caught report-vs-reality risk。

## Source Classification

- `source-backed`: do-what-new gate/report/review discipline, evidence-backed
  verification summaries, findings-first review, and independent re-review risk
  control。
- `alaya-adapted`: the full product gate is Alaya-specific aggregation across
  ALA-R1 through ALA-R11; do-what-new is source material for discipline, not a
  claim that it has the same Alaya product gate。
- `alaya-default`: no new feature defaults are introduced here; this gate uses
  the defaults already owned by preceding Alaya cards。

## Dependencies

- ALA-R1 through ALA-R11 accepted and freshly verified.
- R0 source/doc preflight remains valid for all gate claims.

## Parallel With

- None. R12 is the full-product gate and consumes previous card evidence.
- R12 may schedule checks, but it must not become a scheduling card or add new feature
  ownership.

## Write Ownership

- Planned full smoke report, trust report, benchmark report, export bundle,
  final multi-lens review closeout, and gate evidence artifacts.
- Do not own new product features, visual Inspector delivery, or any claim that
  do-what-new already has the same Alaya product gate.

## Acceptance

- User can install/configure Alaya for a CLI agent。
- Runtime remains the durable truth gate across the whole flow。
- Agent can receive context through MCP or CLI fallback。
- Session audit distinguishes delivered/used/skipped/unverifiable。
- Candidate proposal goes through runtime/governance before durable truth。
- High-risk writes cannot bypass confirmation。
- Gateway can compare/enforce activation-mode behavior。
- Export/backup preserves source/evidence/governance。
- Benchmark report proves memory use quality, not only task completion。
- Graph Inspector data contract is ready without making visual UI a blocker。
- Operator can explain what was recalled, what was used, what changed, and why。

## Verification

Planned implementation verification only:

- After package surface exists: package build/test。
- After install/profile surface exists: clean install/configure smoke。
- After CLI surface exists: doctor/status smoke。
- After MCP surface exists: MCP smoke。
- After CLI fallback exists: CLI fallback smoke。
- After Gateway exists: Gateway smoke。
- After recall/governance surfaces exist: recall/use/propose/govern loop smoke。
- After import/export exists: export/import roundtrip。
- After benchmark harness exists: benchmark fixture run。
- After all prerequisite checks pass: final multi-lens review。

## Review Lens

- correctness。
- architecture。
- trust/security。
- install/release。
- domain language。
- documentation truth。

## Stop Conditions

- If any path can write durable truth without runtime/governance/evidence, gate
  fails。
- If passing the gate requires a feature not owned by ALA-R1 through ALA-R11,
  return `NEEDS_CONTEXT`。
- If source references imply do-what-new has an identical Alaya product gate,
  stop and rewrite the claim。

## Implementation Subcards

### ALA-R12.1 - Full clean install/configure smoke

#### Scope

Run the clean install/configure gate over package installation, local data path,
profile setup, doctor/status, MCP/CLI attachment preview, and host prereq
reporting。

#### Source References

- `docs/v0.1/full-product-loop.md` - install/profile initialization and doctor
  exit conditions。
- `docs/v0.1/task-cards/runtime-truth-kernel.md` - runtime/API/audit write and
  doctor root。
- `docs/v0.1/task-cards/agent-integration.md` - MCP-first, CLI fallback,
  Attach/Profile, Gateway。
- `docs/v0.1/task-cards/operations-and-portability.md` - profile/config/secret
  and portable doctor/status。

#### Acceptance

- Clean temp data dir can initialize storage and runtime without old prototype
  source。
- User and Project profiles can be configured with clear precedence。
- Doctor/status reports runtime, storage, profile, provider, attachment, and
  host prereq state without leaking secrets。
- Attach/Profile writes require preview and confirmation。

#### Verification

Planned smoke covers clean install, first configure, doctor/status, MCP config
preview, CLI fallback config, Attach/Profile preview, and secret redaction。

#### Review Lens

Check install usability, reset/extraction boundary, no-secret output, and
operator-visible failure modes。

#### Stop Conditions

Stop if clean install depends on restoring deleted prototype files or importing
`@do-what/*` runtime code。

### ALA-R12.2 - Recall/use/propose/govern loop gate

#### Scope

Validate the central product loop from recall/context assembly through agent use,
candidate proposal, governance/promotion, durable write/reject/defer, and session
trust summary。

#### Source References

- `docs/v0.1/full-product-loop.md` - recall/context, usage proof, and governance
  loop。
- `docs/v0.1/task-cards/ontology-and-evidence.md` - Memory Ontology and
  Evidence。
- `docs/v0.1/task-cards/structure-registry-and-paths.md` - PathRelation and
  runtime manifestation。
- `docs/v0.1/task-cards/governance-and-promotion.md` - Promotion Gate and HITL。
- `docs/v0.1/task-cards/recall-and-context.md` - recall/context assembly。
- `docs/v0.1/task-cards/provider-and-agent-proposal.md` - provider and
  agent-assisted proposal。
- `docs/v0.1/task-cards/session-audit-and-trust.md` - delivered/used/skipped/
  unverifiable trust states。

#### Acceptance

- Runtime produces context pack with included/excluded reasons and degradation
  metadata。
- Agent use is recorded separately from delivery。
- LLM/connected agent/subagent proposal remains candidate/draft until Alaya
  governance promotes or rejects it。
- High-risk proposal requires HITL and cannot become durable truth through a
  bypass path。
- Session summary explains delivered, used, skipped, unverifiable, and changed
  memory state。

#### Verification

Planned smoke covers recall delivery, use proof, skipped/unverifiable cases,
candidate proposal, HITL promotion/rejection, durable-write audit, and bypass
negative tests。

#### Review Lens

Check durable truth gate, evidence/source requirements, governance safety, and
session trust semantics。

#### Stop Conditions

Stop if any proposal can become durable memory without source/evidence/runtime
governance。

### ALA-R12.3 - Export/backup/benchmark closeout

#### Scope

Validate export/backup integrity, import roundtrip, benchmark fixture execution,
activation-mode comparison, proof-quality report, and release-gate summary。

#### Source References

- `docs/v0.1/full-product-loop.md` - inspect/export/benchmark closeout。
- `docs/v0.1/task-cards/operations-and-portability.md` - export/backup
  integrity。
- `docs/v0.1/task-cards/evaluation-and-benchmark.md` - benchmark harness and
  proof-quality gate。
- `docs/v0.1/task-cards/graph-inspector-contract.md` - graph data contract
  readiness for inspection surfaces。

#### Acceptance

- Export/backup preserves source/evidence/governance/audit/profile integrity。
- Import roundtrip rejects missing evidence, corrupt bundles, and incompatible
  versions。
- Benchmark compares Connect/Attach/Gateway on the same task matrix。
- Benchmark report distinguishes delivered/used/skipped/unverifiable, false
  recall, missed recall, bad ingest, and provider degradation。
- Graph contract readiness is included as data-contract proof only。

#### Verification

Planned checks cover export/import roundtrip, corrupt-bundle rejection,
benchmark run, mode comparison, proof-quality report snapshot, and graph
contract readiness checklist。

#### Review Lens

Check portability, benchmark validity, report reproducibility, and Phase 2
Inspector boundary。

#### Stop Conditions

Stop if closeout cannot prove exported state preserves governance and evidence。

### ALA-R12.4 - Final multi-lens review gate

#### Scope

Run final multi-lens review over R1-R11 delivered evidence, R12 smoke/report
artifacts, documentation truth, residual risks, and release decision。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/workflow/review-protocol.md` -
  findings-first review and fix-loop closure discipline。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:44`
  - verification evidence section style。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/reports/independent-rereview-2026-04-24.md:284`
  - independent review discovered report-vs-reality risk。
- `docs/v0.1/task-cards/README.md` - R1-R11 chain and R12 full-product gate
  position。

#### Acceptance

- Final review includes correctness, architecture, trust/security,
  install/release, domain-language, and documentation-truth lenses。
- All Blocking and Important findings are fixed and re-reviewed before gate
  close。
- Report separates verified facts, skipped checks, deferred work, and residual
  risk。
- Final verdict cites Alaya evidence and does not claim do-what-new has the
  same product gate。

#### Verification

Planned closeout covers review checklist execution, fix-loop evidence,
re-review results, stale-term scan, link/path check, and final gate summary。

#### Review Lens

Check whether the closeout is evidence-backed and whether any claim outruns
implemented R1-R11 truth。

#### Stop Conditions

Stop if final review finds unresolved Blocking/Important findings or if a gate
claim lacks fresh evidence。
