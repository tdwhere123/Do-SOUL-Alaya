# S16 receipt requirement

Exact objective replay from these dumps is **NOT_REPLAYABLE**.

The ancestor E1 `2026-08-23T055902Z` and G21 E1 `2026-08-24T094913Z` dumps do not capture the fields needed to recompute a binding-aware marginal gain, to separate known-zero cover from unavailable cover, or to replay per-step Gamma decisions. `open_semantic_factor_composition.status=unavailable` everywhere that the field exists; `query_sought_facets` is empty; `coverage_marginal_gain`, `selector_observation`, and `answer_features` are null/absent on candidate rows; quality/cover/rho decomposition and objective state are `NOT_CAPTURED`.

Minimum **future** capture (do not start a cache; do not run 1Q/3Q/100Q):

1. Cover availability at query level and per candidate (positive / known-zero / unavailable), not a collapsed numeric 0.
2. Candidate values/atoms (distinct `Values_v` / obligation facets with provenance).
3. Per-step quality / cover / rho decomposition of the walk objective.
4. Objective state immediately before each admission decision.
5. Selected-set receipt (admitted ids, rejected ids, and the gain terms that produced them).

This list is not authorization for a cache root, a provider call, a weight fit, or a 1Q/3Q/100Q ladder. Existing dumps remain the order-level bound only.
