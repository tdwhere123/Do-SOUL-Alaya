# E1a Offline Calibration Evidence — 2026-07-10

## Scope

- Truth plane HEAD: `05d98dfd53bf7c40b925162f015d0ce9daf90289`
- Input: `.do-it/bench-runs/.bench-artifacts/public/2026-07-09T135933Z-56d7cb2-policy-stress/longmemeval-diagnostics.json`
- Input commit: `56d7cb2`
- Execution: current `apps/bench-runner/scripts/evaluate-abstention-calibration.mjs`, unchanged
- Source state: clean before and after; no benchmark or threshold write

## Evidence

The selected schema-v1 artifact contains 100 questions, 90 answerable questions,
88 synthetic leave-gold-out negatives, six true-abstention holdouts, and 1,000
delivered rows. All delivered rows omit the optional runtime-confidence field.

| Signal | Raw AUC | Isotonic holdout AUC | Availability |
| --- | ---: | ---: | ---: |
| top1-top2 fused margin | 0.53333 | 0.65185 | 184/184 offline rows |
| top1-top5-mean fused margin | 0.48889 | 0.52037 | 184/184 offline rows |
| runtime confidence | NOT_VERIFIED | NOT_VERIFIED | 0/184 |

The script exited successfully. It treats true-abstention rows as evaluation-only
and excludes synthetic negatives from production ROC claims.

## Decision

This is supporting fixture evidence only. It does not validate runtime confidence,
the `0.91` threshold, or a production AUC. Runtime threshold publication remains
blocked until a current-HEAD artifact contains the runtime producer output and a
separate live reflection gate passes.

## Residual Risk

- The artifact predates the truth-plane HEAD and represents an I1-floor-on policy-stress run.
- Six true-abstention holdouts are too few for a stable production claim.
- E2 may provide current-HEAD diagnostics, but it is not allowed to silently promote a threshold.
