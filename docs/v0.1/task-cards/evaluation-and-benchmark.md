# ALA-R10 - Evaluation And Benchmark

## Goal

建立 Alaya benchmark harness，比较 Connect / Attach / Gateway activation
mode，证明 agent 是否真的使用记忆，并评估 recall、provider、governance 与
proof quality 是否可靠。

## Source References

- `docs/v0.1/extraction-ledger.md` - Benchmark / evaluation 是
  `alaya-adapted`：抽取 gate/report/model-comparison 纪律，证明 memory use、
  misrecall 与 provider degradation。
- `docs/v0.1/full-product-loop.md` - Benchmark mode 比较 Connect / Attach /
  Gateway 的记忆使用效果。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:3`
  - real task split comparison mode。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:31`
  - first-review findings, fix-loop count, and final verdict comparison。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:44`
  - verification evidence as report input。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/reports/independent-rereview-2026-04-24.md:284`
  - review gate missed failures without independent clean-worktree checks。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/workflow/review-protocol.md` -
  findings-first review, evidence expectations, and fix-loop closure rules。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/maintenance.md` - docs/report
  maintenance and drift-sweep discipline。

## Source Classification

- `source-backed`: do-what-new review/report/model-comparison discipline,
  findings-first review, fix-loop evidence, and verification-summary style。
- `alaya-adapted`: Alaya defines its own benchmark harness, activation-mode
  matrix, proof-quality scoring, memory-use metrics, and release-gate report。
- `alaya-default`: benchmark task families follow the centralized Benchmark
  suite default in [product-alignment-defaults.md](product-alignment-defaults.md);
  this card must not invent a model leaderboard product。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R5 recall/context behavior.
- ALA-R7 delivered/used/skipped/unverifiable proof semantics.
- ALA-R8 Connect/Attach/Gateway activation surfaces and ALA-R9 provider/export
  posture where benchmark fixtures need them.

## Parallel With

- ALA-R11 graph contract work after benchmark treats inspector output as
  derived/read-only evidence only.
- Not parallel with R12; R12 consumes this card's benchmark report.

## Write Ownership

- Planned benchmark task definitions, activation-mode runner, proof-quality
  scoring, report generation, release-gate metrics, and focused tests.
- Do not own UI dashboard delivery, model leaderboard product, or any benchmark
  view as durable truth.

## Acceptance

- benchmark compares Connect / Attach / Gateway with a shared task matrix。
- benchmark task families follow the centralized Benchmark suite default in
  [product-alignment-defaults.md](product-alignment-defaults.md)。
- reports record false recall, missed recall, unused recall, bad ingest,
  provider degradation, and governance-required outcomes。
- reports distinguish blocking violations from diagnostics。
- proof-quality summary includes delivered/used/skipped/unverifiable evidence,
  verification pass rate, findings/fix-loop quality, integration friction, and
  final verdict。

## Verification

Planned implementation verification only:

- deterministic benchmark fixture tests。
- activation-mode comparison tests。
- proof-quality scoring tests。
- degraded provider scenario tests。
- report snapshot tests。

## Review Lens

- benchmark validity。
- trust semantics。
- reproducibility。
- release-gate signal quality。

## Stop Conditions

- If benchmark cannot distinguish delivered vs used, stop and fix session proof
  first。
- If a task family requires changing the centralized default, return
  `NEEDS_CONTEXT` instead of inventing a new default。

## Implementation Subcards

### ALA-R10.1 - Benchmark fixture/task families

#### Scope

Define fixture bundles, task-family registry, expected memory-use conditions,
provider posture fixtures, and deterministic run inputs。

#### Source References

- `docs/v0.1/extraction-ledger.md` - benchmark must prove memory use,
  misrecall, and provider degradation。
- `docs/v0.1/full-product-loop.md` - benchmark evaluates complete memory use
  after install/activation/recall/govern/export surfaces exist。
- [product-alignment-defaults.md](product-alignment-defaults.md) - centralized
  Benchmark suite default, referenced but not changed by this card。

#### Acceptance

- Fixture catalog identifies required memory, optional memory, stale/false
  recall risk, governance-required proposal, and provider-degraded cases。
- Each task defines expected recall, expected non-recall, expected usage proof,
  and expected governance behavior。
- Fixtures are deterministic and do not rely on live provider output for ground
  truth。
- New task families outside the centralized default require parent approval。

#### Verification

Planned tests cover fixture schema validation, deterministic loading, expected
recall labels, stale/false recall labels, and governance-required labels。

#### Review Lens

Check whether fixtures measure Alaya memory behavior rather than generic model
quality。

#### Stop Conditions

Stop if the fixture set cannot express expected-use and expected-non-use
conditions。

### ALA-R10.2 - Connect/Attach/Gateway runner comparison

#### Scope

Implement the activation-mode runner abstraction and compare Connect, Attach,
and Gateway on the same benchmark task set。

#### Source References

- `docs/v0.1/full-product-loop.md` - Connect, Attach, Gateway are the v0.1
  activation modes。
- `docs/v0.1/task-cards/agent-integration.md` - preceding Alaya card owns MCP,
  CLI fallback, Attach/Profile, and Gateway integration。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:3`
  - source report uses real task split comparison。

#### Acceptance

- Runner executes the same task matrix under Connect, Attach, and Gateway。
- Runner records activation setup, delivery channel, fallback path, and whether
  memory was actually used。
- Gateway mode can enforce or fail a benchmark envelope where the task requires
  hard proof。
- Connect/Attach comparison reports cannot treat tool availability as memory
  usage proof by itself。

#### Verification

Planned tests cover shared-task runner parity, mode selection, fallback behavior,
Gateway enforcement, and mode-specific proof records。

#### Review Lens

Check that the comparison isolates activation mode rather than changing task,
fixture, provider, or scoring inputs。

#### Stop Conditions

Stop if runner output cannot explain why a mode succeeded or failed。

### ALA-R10.3 - Proof-quality metrics

#### Scope

Define metrics and scoring for recall quality, memory usage, governance safety,
provider degradation, report confidence, and fix-loop quality。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/workflow/review-protocol.md` -
  findings-first review and evidence requirements。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:31`
  - fix-loop count and final verdict are comparison inputs。
- `docs/handbook/invariants.md` - durable memory writes require explicit source
  and evidence。

#### Acceptance

- Metrics distinguish recall delivered, recall used, recall skipped,
  unverifiable use, false recall, missed recall, and bad ingest。
- Governance metrics flag proposals that require HITL or must remain
  candidate/draft。
- Provider degradation affects confidence without becoming durable truth。
- Scoring output includes raw evidence pointers, not only aggregate numbers。

#### Verification

Planned tests cover metric aggregation, proof evidence mapping, bad-ingest
classification, false/missed recall scoring, and degraded-provider confidence。

#### Review Lens

Check scoring semantics against session audit and governance invariants。

#### Stop Conditions

Stop if scoring can award success when memory was delivered but not used。

### ALA-R10.4 - Report generation and release gate summary

#### Scope

Generate benchmark reports, release-gate summaries, findings/fix-loop sections,
and machine-readable result artifacts。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:44`
  - verification evidence section as report source material。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/reports/independent-rereview-2026-04-24.md:284`
  - independent review found report-vs-reality risk。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/maintenance.md` - report and
  drift-sweep discipline。

#### Acceptance

- Report includes run matrix, fixture ids, activation modes, provider posture,
  scoring summary, verification evidence, findings/fix-loop status, and final
  verdict。
- Release summary separates Blocking gate failures from diagnostics。
- Report preserves enough evidence for independent re-review。
- Report does not claim do-what-new has the same Alaya benchmark gate。

#### Verification

Planned tests cover report snapshots, machine-readable artifact schema,
release-gate aggregation, missing-evidence failure, and final-verdict rendering。

#### Review Lens

Check that report language is evidence-backed, reproducible, and not inflated
from a worker success message。

#### Stop Conditions

Stop if release-gate summary cannot trace every pass/fail to benchmark evidence。
