# ALA-R10 - Evaluation And Benchmark

## Goal

建立 Alaya benchmark harness，比较 Connect / Attach / Gateway，证明 agent 是否真的使用记忆，以及 provider/recall/governance 是否可靠。

## Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:3`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/reports/wave-2-3-model-comparison.md:31`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/reports/independent-rereview-2026-04-24.md:284`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/maintenance.md`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/workflow/review-protocol.md`

## Alaya Adaptation

- do-what-new 提供 gate/report/model-comparison 纪律，不提供可直接复用的 Alaya benchmark harness。
- Alaya benchmark 以 proof quality 为核心，不只看任务 pass/fail。

## Non-goals

- 不实现 UI dashboard。
- 不做模型排行榜产品。

## Scope

- benchmark task definitions。
- activation mode runner。
- proof quality scoring。
- report generation。
- release gate metrics。

## Inputs

- memory fixture bundle。
- agent command。
- activation mode。
- provider posture。

## Outputs

- benchmark report。
- recall-needed / false-recall-risk / governance-needed / provider-degraded / unused-memory metrics。
- proof quality summary。

## Acceptance

- benchmark compares Connect / Attach / Gateway。
- records false recall, missed recall, unused recall, bad ingest。
- distinguishes blocking violations from diagnostics。
- benchmark task families follow the centralized Benchmark suite default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- report includes verification pass rate, findings/fix-loop quality, integration friction, final verdict。

## Verification

- deterministic benchmark fixture tests。
- report snapshot tests。
- activation mode comparison tests。
- degraded provider scenario tests。

## Review Lens

- benchmark validity。
- trust semantics。
- reproducibility。

## Stop Conditions

- If benchmark cannot distinguish delivered vs used, stop and fix session proof first.
