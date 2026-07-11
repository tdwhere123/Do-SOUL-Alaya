# Review: 2026-07-07-composer-recall-root-cause-continuation

**Scope:** recall-root-cause-levers worktree — docs-truth sync after tip land  
**Branch / tip:** `cursor/fix-all-then-full-500q-2017` @ `6bfb5891`  
**Verdict:** **SUPERSEDED** — prior **CLEAR** (early WIP foundation) is no longer valid for tip.  
**Current status:** **review-in-progress / pending parent fix-loop** — do **not** treat as clean.

## Supersession

The earlier review claimed CLEAR for Card A/B/C/E foundation + hygiene WIP. Tip has since landed flood hard-on, Card C runtime fused-margin confidence, ONNX single-flight, F1 reverts, and related recall path changes. That CLEAR verdict and its verification block are **historical only** and must not be cited as current review evidence.

## Tip reality (docs-facing; not a clean claim)

| Theme | Tip state (from commit / worklog; verification pending parent) |
| --- | --- |
| Flood / `answers_with` | Hard-enabled when HQ present — off-switch removed; durable mint surface widened intentionally |
| Card C | Runtime `abstention_confidence_score` producer (fused-margin) landed; Phase-2 `premise_invalid` still deferred |
| F1 / delivery | Prior F1 experiments reverted where they hurt (facet-first restore, tail-rescue shield drop, etc.) |
| ONNX / p95 | Single-flight / thread-cap path in play for bench stability |
| Clean 500Q | **NOT_VERIFIED** on tip — no fresh clean release evidence claimed here |

## Residual risks (open)

- Clean full **500Q** on tip: **NOT_VERIFIED** (prior runs / merge failures do not count as tip release evidence).
- Abstention threshold (e.g. 0.91) may need **live reflection** after confidence producer land — offline calibration ≠ product threshold lock.
- Always-on `answers_with` minting when HQ exists widens the durable write surface (intentional; not a silent control-plane→memory leak, but governance-visible).
- Parent fix-loop / review-loop must re-run before any CLEAR or “tests pass” claim.

## Verification

**Pending parent.** This docs-only pass does **not** re-run build/tests or claim green. Do not promote tip to review-clean without fresh parent evidence.
