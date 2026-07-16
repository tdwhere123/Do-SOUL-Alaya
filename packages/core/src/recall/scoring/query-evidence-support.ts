import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { hasTemporalQuerySignal } from "../query/recall-query-plan.js";
import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../runtime/recall-service-types.js";

const NON_EMBEDDING_QUERY_EVIDENCE_STREAMS: readonly RecallFusionStream[] = Object.freeze([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "subject_alignment",
  "entity_seed",
  "facet_overlap"
]);

export function hasNonEmbeddingQueryEvidenceRank(
  ranks: Readonly<RecallFusionStreamRanks>,
  queryProbes: Readonly<RecallQueryProbes> | undefined
): boolean {
  if (NON_EMBEDDING_QUERY_EVIDENCE_STREAMS.some((stream) => ranks[stream] !== null)) {
    return true;
  }
  return queryProbes !== undefined &&
    hasTemporalQuerySignal(queryProbes) &&
    ranks.temporal_recency !== null;
}

export function hasQueryEvidenceContribution(
  contributions: Readonly<RecallFusionStreamContributions>,
  queryProbes: Readonly<RecallQueryProbes>
): boolean {
  if ((contributions.embedding_similarity ?? 0) > 0) return true;
  if (NON_EMBEDDING_QUERY_EVIDENCE_STREAMS.some(
    (stream) => (contributions[stream] ?? 0) > 0
  )) {
    return true;
  }
  return hasTemporalQuerySignal(queryProbes) &&
    (contributions.temporal_recency ?? 0) > 0;
}
