import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../runtime/recall-service-types.js";

export type RecallFusionFamilyId =
  | "semantic"
  | "lexical"
  | "structural"
  | "graph_path"
  | "temporal_facet";

// Correlated projections share one family ballot so repeated views of the same
// evidence cannot multiply topical popularity against independent signals.
export const RECALL_FUSION_FAMILY_STREAMS: Readonly<
  Record<RecallFusionFamilyId, readonly RecallFusionStream[]>
> = Object.freeze({
  semantic: Object.freeze(["embedding_similarity"] as const satisfies readonly RecallFusionStream[]),
  lexical: Object.freeze([
    "lexical_fts",
    "trigram_fts",
    "synthesis_fts",
    "evidence_fts"
  ] as const satisfies readonly RecallFusionStream[]),
  structural: Object.freeze([
    "evidence_structural_agreement",
    "source_proximity",
    "source_evidence_agreement",
    "structural",
    "existing_score"
  ] as const satisfies readonly RecallFusionStream[]),
  graph_path: Object.freeze([
    "graph_expansion",
    "entity_seed",
    "path_expansion"
  ] as const satisfies readonly RecallFusionStream[]),
  // subject_alignment is query-conditioned (self/preference), not topical-popularity ρ
  // with existing_score — keep it out of structural max so personal queries still lift.
  temporal_facet: Object.freeze([
    "temporal_recency",
    "workspace_activation",
    "facet_overlap",
    "subject_alignment"
  ] as const satisfies readonly RecallFusionStream[])
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
export function aggregateFamilyContributions(
  contributions: Readonly<Partial<Record<RecallFusionStream, number>>> | RecallFusionStreamContributions
): number {
  let total = 0;
  for (const familyId of RECALL_FUSION_FAMILY_IDS) {
    let familyVote = 0;
    for (const stream of RECALL_FUSION_FAMILY_STREAMS[familyId]) {
      const contribution = contributions[stream] ?? 0;
      if (contribution > familyVote) {
        familyVote = contribution;
      }
    }
    total += familyVote;
  }
  return total;
}

export function countFamiliesWithHits(
  candidates: readonly Readonly<{ readonly per_stream_rank: RecallFusionStreamRanks }>[]
): number {
  let familiesWithHits = 0;
  for (const familyId of RECALL_FUSION_FAMILY_IDS) {
    const streams = RECALL_FUSION_FAMILY_STREAMS[familyId];
    const hit = candidates.some((candidate) =>
      streams.some((stream) => candidate.per_stream_rank[stream] !== null)
    );
    if (hit) {
      familiesWithHits += 1;
    }
  }
  return familiesWithHits;
}
