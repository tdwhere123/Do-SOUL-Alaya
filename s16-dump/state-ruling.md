# S16 state-ruling draft

Coverage has three semantically different states. These 100Q dumps exercise only one of them.

| State | Dump fact on this 100Q | Current numeric path | Ruling |
| --- | --- | --- | --- |
| Positive incremental cover | **not observed** (composition unavailable; Values_v available 0/100) | quality + cover − rho | Preserve. Do not change from this dump. |
| Known-zero incremental cover | **not observed as distinct from unavailable** | `fused_score − rho` | Preserve the known-zero numeric. Do not treat unavailable evidence as proof of zero cover. |
| Unavailable / unobserved cover | **everywhere** on ancestor E1 and G21 E1 | G21 uses rank-only (`fused_score − rho`); ancestor used quality admission | See fallback comparison. |

## Legal choices for unavailable cover

1. **Rank-only fallback** (current G21 numeric: `fused_score − rho`). Observed order is the G21 E1 delivered set. Head-recovery of the fused-head census misses is the intended ranking-preserve effect; waist losses and collateral churn are the measured cost.
2. **Bounded quality fallback** (hypothesis). Shape: quality may not displace fused-head (`fused_rank<=5`); quality may still compete below that head. Order-level verdict from `order-bound.md`: **FALSIFIED**. Exact replay: **NOT_REPLAYABLE**. This is not a production PASS and must not be implemented from this dump. No constant is fitted.
3. **Explicit degraded / abstaining path.** KPI scorable freeze already excludes 6 abstention questions. No dump field on the 94 scorable marks an unavailable-cover abstention. **No dump support** for routing unavailable cover to abstain.

## Recommendation

**Rank-only remains the production unavailable fallback.** The order-level bound does not legalize a new production objective. Bounded quality is a hypothesis (FALSIFIED at order level only) and is not authorized as code. Preserve positive-cover and known-zero numeric behavior. Do not overwrite pin `3af4fd9`. Dual-13 stays honest no-fix. No miss-ID patch, retune, cache, or 1Q/3Q/100Q follows from this ruling.

Replay of exact scores/atoms is NOT_REPLAYABLE because cover availability, candidate Values_v/atoms, per-step quality/cover/rho, and objective state were not captured. At order level, head-recovery (4: 001be529, 6b168ec8, 6f9b354f, 726462e0) and waist-loss (19: 21436231, 29f2956b, 2ce6a0f2, 3d86fd0a, 545bd2b5, 577d4d32, 58ef2f1c, 5d3d2817, 66f24dbb, 7024f17c, 86f00804, af8d2e46, b86304ba, c4a1ceb8, c5e8278d, d52b4f67, faba32e5, gpt4_7fce9456, gpt4_d84a3211) are disjoint. Within-question conflicts 12; same-slot gold conflicts 12. At least one question requires both protecting a fused-head gold and keeping a waist quality admittee of that slot, so simultaneous both-on-that-question is FALSIFIED. Conflict-free questions remain 82/94. The shape is not a production PASS.
