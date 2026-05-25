# v0.3.11 Implementation Checkpoint

Status: **implementation checkpoint; release evidence pending**.

v0.3.11 remains the release-gate track for public benchmark integrity, but
the current branch is not release-ready. Full public benches have not been
rerun on HEAD `96e9bb9`, and the tracked bench-history pointers are legacy
baselines rather than current v0.3.11 release evidence.

## Current Branch Truth

The checkpoint branch includes these post-review commits:

| Commit | Scope | Evidence status |
|---|---|---|
| `621fcec` | Governance and bench-integrity checkpoint: edge proposals, LoCoMo gate contract, token-economy archive/report plumbing, strict-real live runner repair, local ONNX cache-path docs, compact diagnostics policy | Implementation landed; current full bench evidence pending |
| `8d2cbf7` | Multilingual BM25 tokenization and CJK segmentation | Implementation landed; full public bench evidence pending |
| `8bf07c8` | Two-hop graph expansion diagnostics | Implementation landed; full public bench evidence pending |
| `96e9bb9` | Weak-evidence abstention calibration | Implementation landed; full public bench evidence pending |

The artifact-hygiene cleanup staged by a separate worker removes old tracked
full diagnostics only. It must not be treated as KPI, report, or pointer
evidence.

## Release Gates Still Open

The active v0.3.11 release gates are:

| Gate | Required result |
|---|---|
| LongMemEval-S 500 embedding off | R@5 >= 90% |
| LongMemEval-S multiturn 500 embedding off | R@5 >= 90% |
| LongMemEval-S crossquestion 500 embedding off | R@5 >= 90% |
| LoCoMo 1982 embedding off | R@5 >= 55% |
| LoCoMo 1982 local ONNX embedding on | R@5 >= 90% |
| Token economy | every new full bench includes `recall_token_economy` per recall call |

The local ONNX model cache is currently absent unless the parent supplies or
fetches it before the embedding-on LoCoMo run.

## Evidence Pointers

Current tracked `latest-baseline*` pointers are stale legacy aliases, not
release evidence for HEAD `96e9bb9`. Future full benches must write
`latest-run*`; only passing release-gate archives may advance
`latest-passing*`.

The implementation checkpoint report is
[`reports/v0.3.11-implementation-checkpoint.md`](reports/v0.3.11-implementation-checkpoint.md).
It maps the original B1/B2/I1-I9/N1 review findings to landed implementation
evidence and remaining verification.

## Closeout Rule

Do not mark v0.3.11 as final, release-ready, or full-evidence-passed until:

1. the five Tier 1 full benches above run on the current branch,
2. each archive includes the required token-economy block,
3. `latest-run*` and `latest-passing*` semantics are exercised by the new
   writes,
4. the final closeout report maps B1/B2/I1-I9/N1 to fresh verification, and
5. the parent review reports no unresolved Blocking or Important findings.
