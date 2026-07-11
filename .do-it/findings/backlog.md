# Recall Forward Backlog

Only work explicitly deferred from the active recall-forward wave belongs here.

- **BL-069 — Materialized SliceKey index**: consider a dedicated projection index only if read-time derivation has measured latency or query-plan cost that prevents the 1100 ms release target. Any future index remains rebuildable and non-ontological.
- **BL-070 — Warm-state / LongMemEval-V2**: start after cold static recall meets the release quality and latency gates.
- **BL-071 — Hub inflation and FACET_SLICE product default**: revisit only under the edge-transfer and SliceKey diagnostics contract; blind default changes remain forbidden.
- **BL-072 — Soft I1 challenger rescue**: reconsider only after conditional-flood experiments or new miss evidence invalidate the current negative result.
- **BL-073 — General multi-hop flood**: remain deferred unless the S4 evidence gate proves two-hop reachability can close the measured gold-bearing gap.
- **BL-074 — Conservative entity/space query producers**: v1 source/target derivation and contracts support typed entity/space keys, but the production query producer currently emits semantic/time keys only. Add entity or space query keys only from explicit typed query evidence; do not infer them from memory-entry IDs or loose text matching. S5 must report per-dimension query/source/target coverage before this is promoted.
- **BL-075 — Object-anchor routing and representative Slice coverage**: object Path anchors intentionally contribute no v1 key today. Do not invent an object key from identity alone. Reopen only with a typed query producer and an offline report covering query/source/target dimensions, populated snapshot ratio, relevant-path coverage, and known-disjoint rate; nonzero facet coverage is only a vacuity guard.
