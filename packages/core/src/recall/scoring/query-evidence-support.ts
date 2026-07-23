import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { hasTemporalQuerySignal } from "../query/recall-query-plan.js";
import type {
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../runtime/recall-service-types.js";

const DIRECT_QUERY_EVIDENCE_STREAMS: readonly RecallFusionStream[] = Object.freeze([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "entity_seed",
  "facet_overlap"
]);

const NON_EMBEDDING_QUERY_EVIDENCE_STREAMS: readonly RecallFusionStream[] = Object.freeze([
  ...DIRECT_QUERY_EVIDENCE_STREAMS,
  "subject_alignment"
]);

export function hasNonEmbeddingQueryEvidenceRank(
  ranks: Readonly<RecallFusionStreamRanks>,
  queryProbes: Readonly<RecallQueryProbes> | undefined,
  maxRank = Number.POSITIVE_INFINITY
): boolean {
  if (DIRECT_QUERY_EVIDENCE_STREAMS.some((stream) => rankIsWithin(ranks[stream], maxRank))) {
    return true;
  }
  return queryProbes !== undefined &&
    hasTemporalQuerySignal(queryProbes) &&
    rankIsWithin(ranks.temporal_recency, maxRank);
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

function rankIsWithin(rank: number | null, maxRank: number): boolean {
  return rank !== null && rank <= maxRank;
}
