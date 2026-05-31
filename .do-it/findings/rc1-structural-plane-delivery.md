# RC-1 Deep-Dive: Why STRUCTURAL planes win ZERO delivered slots (read-only)

Scope: characterize the mechanism behind the established finding
(`.do-it/findings/r5-degradation-rootcause.md`) that on the 100q
LongMemEval-S `embedding=disabled` run, every delivered/top-5/gold-hit
slot has `plane_winning_admission = lexical` and the structural planes
(graph_expansion / path_expansion / evidence_anchor / activation /
session_surface_cohort) admit but never deliver. NO code edits, NO bench
run, NO constant-value proposals. All file:line refs are
`packages/core/src/recall-service.ts` unless stated otherwise.

## VERDICT: MIXED

Two genuinely separate things are conflated in the headline:

1. **The "100% lexical winning admission" headline is largely an
   ATTRIBUTION ARTIFACT, not proof that structural fusion contributed
   zero score.** `plane_winning_admission` is a `RecallAdmissionPlane`
   tag chosen by a fixed priority list with `lexical` FIRST
   (`RECALL_ADMISSION_ATTRIBUTION_ORDER`, line 5225-5239). Any candidate
   co-admitted on the lexical plane is labeled `lexical` regardless of
   whether graph_expansion/path_expansion also admitted it and fed its
   fused_score. The metric measures admission provenance, not which
   fusion stream won the slot. So the diagnostic does NOT directly prove
   "structural scoring = 0 at delivery"; it proves "every delivered
   candidate was at least partly lexically admitted." (Facts §A.)

2. **That structural-ONLY candidates never reach top-N is EXPECTED RRF
   behavior, and is mostly INDEPENDENT of embedding.** Structural streams
   have real non-embedding scoring (graph topology / path topology), but
   RRF rewards multi-stream presence, and a structural-only candidate
   fires on ONE stream while a relevant lexical candidate accumulates
   across many. With a fixed top-N (=10 here) cut by fused_score, the
   single structural term cannot out-sum the lexical multi-stream sum.
   This is a property of the fusion arithmetic, not an embedding-off
   defect — it would persist embedding-ON for structural-only golds.
   (Facts §B, §C.)

3. **The `2ce6a0f2` RRF-rank vs delivered-rank divergence is REAL but is
   NOT a fusion ordering bug.** It is two intentionally-different keys:
   `pre_budget_rank`/`fused_rank` is frozen at fusion-build time (sorted
   by fused_score), while the DELIVERED order is the post-rerank/reorder
   sequence (`selection_order`). A feature-rerank pass blends a lexical
   feature score on top of normalized fusion and can move a candidate
   across the delivery-5 boundary relative to its fused_rank. So a gold
   with a top-5 fused_score legitimately delivers at position 6. (Facts §D.)

None of the three is a contained "fix this line" bug. The lexical
monoculture at delivery is the designed consequence of RRF + single-plane
budget; the divergence is a measurement-vs-delivery key difference, not an
inconsistent sort.

## A. `plane_winning_admission` is admission attribution, not scoring (VERIFIED)

- `RecallAdmissionPlane` (recall-service-types.ts:321-338) and
  `RecallFusionStream` (recall-service-types.ts:352-369) are DIFFERENT
  namespaces. "lexical" is an admission plane; "lexical_fts" is a fusion
  stream. The finding's `plane_winning_admission = lexical` is the
  admission tag.
- `createDiagnostic` sets `plane_winning_admission =
  selectRecallAdmissionAttributionPlane(admissionPlanes, firstAdmissionPlane)`
  (line 3195-3206).
- `selectRecallAdmissionAttributionPlane` (5241-5251) returns the FIRST
  plane in `RECALL_ADMISSION_ATTRIBUTION_ORDER` that the candidate was
  admitted on. That order is
  `[lexical, source_proximity, path_expansion, graph_expansion,
  evidence_anchor, object_probe, protected_winner, domain_tag_cluster,
  session_surface_cohort, semantic_supplement, activation]`
  (5225-5239) — `lexical` is index 0.
- Consequence: a candidate admitted on BOTH `lexical` and
  `graph_expansion` reports `plane_winning_admission = lexical`. The "100%
  lexical" headline therefore does not isolate fusion contribution.
- This is consistent with — but weaker than — the finding's secondary
  localization (structural-ONLY golds landing at fused ranks 248-490),
  which IS a genuine scoring/ranking signal. That localization, not the
  attribution headline, is the load-bearing evidence.

## B. Structural candidates DO get a non-embedding fusion score (VERIFIED)

`scoreRecallFusionStream` (3686-3769) scores EVERY candidate on EVERY
stream by `object_id` lookup — it does NOT gate a stream on which plane
admitted the candidate. So a graph-admitted candidate that also has an
FTS hit gets lexical_fts credit, and a lexical-admitted candidate that
also has graph support gets graph_expansion credit. Streams are
content/topology-keyed, not admission-gated.

Per-stream sources for the structural streams (all NON-embedding):
- `graph_expansion` (3746-3753): `max(graphExpansionScores[id],
  normalizeGraphSupport(graphSupportCounts[id]))`. `graphExpansionScores`
  is set from the structural score at admission (lines 966-971);
  `normalizeGraphSupport` (recall-service-helpers.ts:166-177) =
  `clamp(count,0,3)/3` over positive-only inbound path weight. Graph
  topology, no embedding.
- `path_expansion` (3759-3763): `pathExpansionScores[id]`, set from the
  structural score at admission (978-983). Path topology, no embedding.
- `structural` (3738-3741), `evidence_structural_agreement` (3721-3725,
  geometric mean of evidence FTS x structural), `subject_alignment`
  (3736-3737, regex self/user framing), `temporal_recency` (3764-3765,
  age decay), `workspace_activation` (3766-3767, activation_score).
  None embedding-dependent.
- `embedding_similarity` (3744-3745) is the ONLY embedding stream; with
  `embedding_mode=disabled` it is ~0 for all (matches finding's "embedding
  plane empty by design").

So "embedding off zeroes structural scoring" is FALSE. Structural streams
produce real scores embedding-off. The reason they don't win is RRF
arithmetic (§C), not a zeroed score path.

## C. The fused score is RRF; single-stream structural cannot out-sum multi-stream lexical (VERIFIED)

`buildRecallFusionDetails` (3534-3620):
- For each stream, candidates with stream-score > 0 are ranked 1..n
  (3543-3561).
- `fused_score = sum over streams of weight[stream] / (k + rank[stream])`
  with `k = RECALL_RRF_DEFAULT_K = 60` (line 261, resolved 4017-4033).
- `fused_rank` is then assigned by sorting on `fused_score` DESC (3590-3601).
  So at build time fused_rank and fused_score are CONSISTENT — there is no
  intra-build ordering bug.

Magnitude (default weights, lines 287-315; `graph_expansion=3`,
`path_expansion=3`, `lexical_fts=1`, `trigram_fts=1`, `evidence_fts=3`,
`evidence_structural_agreement=6`, `existing_score=8`, ...):

- A structural-ONLY candidate firing only on `graph_expansion` at its best
  possible stream rank 1 contributes `3/(60+1) = 0.0492` and nothing else
  -> total fused_score ~= 0.049.
- A relevant lexical candidate fires on several streams
  (lexical_fts + trigram_fts + evidence_fts + evidence_structural_agreement
  + source_proximity + existing_score + subject_alignment). Even at
  middling ranks the sum is multiples of a single 0.049 term (e.g. just
  `existing_score` w=8 at rank 1 = 8/61 = 0.131, already 2.7x the entire
  graph-only score).

This is exactly the property the code itself documents for the synthesis
stream: synthesis_fts weight=8 is called "inert for delivery" because "a
synthesis candidate cannot out-RRF a multi-stream memory_entry" (292-297,
3901-3910), which is why synthesis gets a hard delivery RESERVE
(`reserveSynthesisDeliverySlots`, 3929-3969) instead of competing on
fused rank. The SAME structural property applies to graph/path-only
candidates — and they have NO analogous reserve. So structural-only golds
land at fused ranks in the hundreds (finding §3: 248-490) and are cut by
the top-N budget. EXPECTED, and embedding-independent.

Raising the graph_expansion weight would not change the regime within
reason: even graph_expansion=8 (=existing_score) gives a single-stream
0.131, still below a multi-stream lexical sum; only an extreme weight
would invert it, which the project forbids (no constant-tuning) and which
would be a benchmark-specific hack, not a holistic fix.

## D. graph weight reaches delivery; the divergence is two keys, not a sort bug (VERIFIED)

Delivery pipeline order in `fineAssess` (3094-3317):
1. `computeEffectiveScoreDetails` per candidate (3112-3128).
2. `buildRecallFusionDetails` -> fused_score + fused_rank (3129-3134).
   **The graph_expansion / path_expansion fusion WEIGHTS ARE applied here**,
   so they DO reach the delivery score (the weight is not stranded at an
   admission-only stage). They simply lose the RRF sum (§C).
3. `applyPathSuppressionToFusionScores` (3139-3142) — sign-aware negative
   demotion; no-op when no suppression. Re-ranks by suppressed score.
4. `scoredCandidates.sort(compareFusedRecallCandidates)` (3147-3148) —
   sorts by `fused_score` DESC, tiebreak effectiveScore then entry compare
   (3822-3835). This is the SCORE-ordered list.
5. `applyFeatureRerank` (3149) -> `rerankTopN` (recall-feature-rerank.ts:
   685-751): reorders the top-50 by
   `blended = 1.0*normalizedFusion + 0.35*lexicalScore`
   (RECALL_RERANK_BLEND, recall-feature-rerank.ts:31-34;
   normalizedFusion = fusedScore/maxFusion, 728-730). lexicalScore is a
   lexical feature blend (exact_phrase/term_coverage/rare_term_coverage/
   proximity, 42-57) — purely lexical, so this pass can only RAISE lexical
   candidates and LOWER non-lexical ones within the window.
6. `prioritizeStrongLexicalDeliveryWindowCandidates` (3150-3151) — defers
   source-proximity-local-only candidates behind strong lexical ones in
   the window.
7. `reserveSynthesisDeliverySlots` (3150-3158).
8. `appendCandidate` reduce over `deliveryOrderedCandidates` (3308-3311):
   assigns `selection_order = index+1` and enforces `max_entries` /
   `max_total_tokens` / per-dimension cap; over-budget candidates get
   `dropped_reason="max_entries"` (3259-3267).

The divergence: in `createDiagnostic` (3199-3214),
`pre_budget_rank = candidate.fusion.fused_rank` AND
`fused_rank = candidate.fusion.fused_rank` are the FROZEN score-rank from
step 2/3 — they are NOT recomputed after the rerank/reorder. But
`selection_order` (and the bench's `deliveredResults[].rank`, which is what
R@k is measured on per `e67ae48 fix(bench): measure monotonicity by
delivered rank` and longmemeval-runner.test.ts:440) is the POST-rerank
delivery position. So a gold at fused_rank 5 reranked down to delivery
position 6 will show "fused_score top-5 but delivered at rank 6" — the
`2ce6a0f2` signature. This is two intentionally different metrics
(score-rank vs delivered-rank), exactly as the rerank docstring intends
(recall-feature-rerank.ts:8-17, 670-684 — "the rerank does not replace
fusion ... reordered by lexical features"). It is NOT an inconsistent sort
within a single key.

Caveat: this means the feature-rerank (a LEXICAL signal blended at 0.35)
is an ADDITIONAL pressure pushing borderline non-lexical golds out of the
delivery window AFTER fusion. It does not create the lexical monoculture
(RRF already does, §C) but it sharpens it at the top-5/6 boundary, which
is precisely where the near-miss cliff lives (finding §3). Whether that
0.35 lexical headroom should be allowed to demote a fusion-top-5 gold is a
policy question for whoever directs the recall change — flagged, not fixed.

## Answers to the four investigation questions

1. **Delivered ranking = fused SCORE, then lexical-feature rerank, then
   reorder/reserve passes; budget cut by flat top-N on that final order.**
   Pre-budget `fused_rank` (RRF) and delivered rank (`selection_order`)
   are DIFFERENT keys. A high-fused-score candidate CAN sit below the cut
   after the rerank. The `2ce6a0f2` divergence is two intentional metrics,
   not an ordering inconsistency bug.

2. **Structural candidates DO get a non-embedding score** (graph/path
   topology, structural agreement, activation, recency, subject alignment;
   §B). Embedding-off does NOT zero them. They still never win because RRF
   multi-stream summation buries a single structural term under multi-stream
   lexical sums (§C). So this is "expected RRF behavior," not "embedding
   needed for structural scoring" — the two are different claims and only
   the first holds.

3. **The graph_expansion weight (=3) IS applied to the delivered ranking**
   (it feeds fused_score in `buildRecallFusionDetails`, step 2, which feeds
   the delivery sort). It is NOT stranded at admission. It just loses the
   RRF sum; the weight reaches delivery but is arithmetically
   non-decisive (§C, §D).

4. **The top-N budget is a flat top-N by final delivery order**
   (`max_entries`, enforced in `appendCandidate`, 3259-3267). There is NO
   plane-diversity / per-plane quota in the general cut. The ONLY reserved
   slots are `SYNTHESIS_DELIVERY_RESERVE = 2` for synthesis_capsule
   (3911-3969) — a precedent that the same single-stream-RRF problem was
   already solved for synthesis with a reserve, but NOT for graph/path. A
   single lexical cluster can monopolize all 10 delivered slots.

## Facts verified

- `RECALL_FUSION_DEFAULT_WEIGHTS`: graph_expansion=3, path_expansion=3,
  entity_seed=1, lexical_fts=1, trigram_fts=1, evidence_fts=3,
  evidence_structural_agreement=6, existing_score=8, synthesis_fts=8
  (inert for delivery), embedding_similarity=1, temporal_recency=0,
  workspace_activation=0 (287-315). RRF k=60 (261).
- fused_score = sum weight/(k+rank); fused_rank sorted by fused_score
  (3563-3601) — internally consistent.
- Structural streams are content/topology-keyed, non-embedding
  (3703-3767); embedding_similarity is the only embedding stream and is ~0
  embedding-off.
- `plane_winning_admission` uses `RECALL_ADMISSION_ATTRIBUTION_ORDER` with
  `lexical` first (5225-5251); it is admission provenance, not winning
  fusion stream.
- Delivered order = fused_score sort -> lexical feature rerank
  (blend 1.0/0.35, recall-feature-rerank.ts:31-34, 728-735) -> reorder ->
  synthesis reserve; `selection_order` is post-rerank; `fused_rank`/
  `pre_budget_rank` is pre-rerank frozen score-rank (3199-3214, 3308-3311).
- Budget is flat top-N (`max_entries`) with no plane quota; only synthesis
  has a reserve (SYNTHESIS_DELIVERY_RESERVE=2, 3911-3969).
- Bench measures R@k by delivered rank (longmemeval-runner.test.ts:440,
  commit e67ae48), so a fused-top-5/delivered-6 gold is scored a miss.

## Unknowns

- Exact `max_entries` for the chat policy at runtime (the diagnostics show
  delivered_results length 10; the policy value was not located in-repo
  for the chat shape — task-surface-builder uses 15/20/25/30, recall tests
  use 5/10). Not needed for the mechanism; the cut is a flat top-N either
  way.
- How WIDESPREAD the rerank-driven cross-boundary demotion is (D) vs the
  pure-RRF burial (C) across the 16 misses — only `2ce6a0f2` was traced in
  the prior finding. A full delivered-vs-fused-rank census per miss would
  separate "rerank pushed a fusion-top-5 gold out" from "gold was never
  fusion-top-5." Not run here (READ-ONLY; no bench).
- Whether any structural-co-admitted gold actually reached the delivery
  window on a lexical-driven fused_score (i.e. lexical+graph co-admit). The
  attribution artifact (§A) hides this in the existing diagnostics; a
  per-stream-contribution scan of delivered slots would quantify it.

## Stop reason

All four investigation questions answered against source with file:line.
The verdict (MIXED) is pinned: the headline is partly an attribution
artifact, structural zero-delivery is expected RRF behavior independent of
embedding, and the rank-vs-delivered-rank divergence is two intentional
keys plus a lexical-rerank pressure — none a contained ordering bug. The
real test of the graph layer is the embedding-ON run (K1.5), since
embedding-off vs -on does NOT change the structural-burial regime;
embedding-on only adds a parallel non-lexical stream that can co-credit
structural-admitted candidates. The embedding-OFF 90% target (K1.1) is the
harder, architecturally-distinct question (flat-top-N + RRF single-stream
burial + multi-gold sets). Further depth (full divergence census,
per-stream delivered-slot contribution scan, runtime max_entries) needs a
bench/instrumented run, which is out of this read-only scope and would
risk crossing into constant-tuning. No constant values recommended.
