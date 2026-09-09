export type RecallFusionFamilyId =
  | "semantic"
  | "lexical"
  | "structural"
  | "graph_path"
  | "temporal_facet";

// Correlated projections share one family ballot so repeated views of the same
// evidence cannot multiply topical popularity against independent signals.
export const RECALL_FUSION_FAMILY_STREAMS: Readonly<
  Record<RecallFusionFamilyId, readonly string[]>
> = Object.freeze({
  semantic: Object.freeze(["embedding_similarity"]),
  lexical: Object.freeze([
    "lexical_fts",
    "trigram_fts",
    "synthesis_fts",
    "evidence_fts"
  ]),
  structural: Object.freeze([
    "evidence_structural_agreement",
    "source_proximity",
    "source_evidence_agreement",
    "structural",
    "existing_score"
  ]),
  graph_path: Object.freeze([
    "graph_expansion",
    "entity_seed",
    "path_expansion"
  ]),
  // subject_alignment is query-conditioned (self/preference), not topical-popularity ρ
  // with existing_score — keep it out of structural max so personal queries still lift.
  temporal_facet: Object.freeze([
    "temporal_recency",
    "workspace_activation",
    "subject_alignment"
  ])
});

export const RECALL_FUSION_FAMILY_IDS: readonly RecallFusionFamilyId[] = Object.freeze([
  "semantic",
  "lexical",
  "structural",
  "graph_path",
  "temporal_facet"
]);

// Max, not mean: a family casts one ballot at the strength of its strongest member.
// Correlated duplicates collapse (max(a,a,a)=a); a lone strong lane is not diluted by
// weak siblings. Mean would still be ~one vote under high ρ, but softens the best signal.
export function familyMaxContributionsById(
  contributions: Readonly<Partial<Record<string, number>>>
): Readonly<Record<RecallFusionFamilyId, number>> {
  const entries = RECALL_FUSION_FAMILY_IDS.map((familyId) => {
    let familyVote = 0;
    for (const stream of RECALL_FUSION_FAMILY_STREAMS[familyId]) {
      const contribution = contributions[stream] ?? 0;
      if (contribution > familyVote) {
        familyVote = contribution;
      }
    }
    return [familyId, familyVote] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as Record<
    RecallFusionFamilyId,
    number
  >);
}

export function aggregateFamilyContributions(
  contributions: Readonly<Partial<Record<string, number>>>
): number {
  const byId = familyMaxContributionsById(contributions);
  let total = 0;
  for (const familyId of RECALL_FUSION_FAMILY_IDS) {
    total += byId[familyId];
  }
  return total;
}
