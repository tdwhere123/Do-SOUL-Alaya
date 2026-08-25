import type { RecallCandidate, RecallScoreFactors } from "@do-soul/alaya-protocol";
import { clamp01 } from "../../../shared/clamp.js";
import {
  buildRecallCandidateDedupeKey,
  normalizeActivationScore
} from "../../runtime/recall-service-helpers.js";
import type {
  RecallCandidateDiagnostic,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks
} from "../../runtime/recall-service-types.js";
import type { FineAssessParams } from "../../delivery/fine-assessment.js";

const FUSION_STREAMS = [
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "entity_seed",
  "path_expansion",
  "temporal_recency",
  "workspace_activation"
] as const satisfies readonly RecallFusionStream[];

const EMPTY_STREAM_RANKS = Object.freeze(Object.fromEntries(
  FUSION_STREAMS.map((stream) => [stream, null])
)) as RecallFusionStreamRanks;

const EMPTY_STREAM_CONTRIBUTIONS = Object.freeze(Object.fromEntries(
  FUSION_STREAMS.map((stream) => [stream, 0])
)) as RecallFusionStreamContributions;

export function buildCanonicalDeliveryDiagnostics(
  params: FineAssessParams,
  delivered: readonly Readonly<RecallCandidate>[]
): readonly Readonly<RecallCandidateDiagnostic>[] {
  const deliveredRank = new Map(delivered.map((candidate, index) => [
    `${candidate.origin_plane}:${candidate.object_kind}:${candidate.object_id}`,
    index + 1
  ]));
  return Object.freeze(params.candidates.map((coarse, index) => {
    const key = buildRecallCandidateDedupeKey(coarse);
    const rank = deliveredRank.get(key);
    const inPacket = rank !== undefined;
    const order = rank ?? index + 1;
    const planes = Object.freeze([
      ...(coarse.admissionPlanes ?? ["activation" as const])
    ]);
    return Object.freeze({
      candidate_key: key,
      object_id: coarse.entry.object_id,
      object_kind: coarse.objectKind ?? "memory_entry",
      created_at: coarse.entry.created_at,
      dimension: coarse.entry.dimension,
      origin_plane: coarse.originPlane ?? "workspace_local",
      admission_planes: planes,
      plane_first_admitted: coarse.firstAdmissionPlane ?? planes[0] ?? "activation",
      plane_winning_admission: planes[0] ?? "activation",
      pre_budget_rank: order,
      selection_order: order,
      admission_attempts: Object.freeze([{
        pass: "final_selector" as const,
        selection_order: order,
        admitted: inPacket,
        dropped_reason: inPacket ? null : "rank_displaced" as const
      }]),
      evidence_projection_matches: Object.freeze([]),
      fused_rank: order,
      fused_score: 0,
      per_stream_rank: EMPTY_STREAM_RANKS,
      fused_rank_contribution_per_stream: EMPTY_STREAM_CONTRIBUTIONS,
      final_rank: rank ?? null,
      post_rank: rank ?? null,
      in_final_packet: inPacket,
      eviction_reason: inPacket ? null : "rank_displaced" as const,
      dropped_reason: inPacket ? null : "rank_displaced" as const,
      within_budget: inPacket,
      relevance_score: 0,
      additive_score: 0,
      lexical_rank: null,
      structural_score: 0,
      score_factors: canonicalDiagnosticScoreFactors(
        coarse.entry.object_id,
        coarse.entry.activation_score ?? 0,
        params
      ),
      source_channels: Object.freeze([
        ...(coarse.sourceChannels ??
          (coarse.sourceChannel === undefined ? [] : [coarse.sourceChannel]))
      ]),
      path_expansion_sources: Object.freeze([]),
      path_suppression_score: 0,
      rank_after_coverage_selector: order,
      coverage_selector_action: inPacket ? "kept" as const : "displaced" as const,
      session_key: coarse.entry.surface_id ?? coarse.entry.run_id ?? "<no-session>"
    });
  }));
}

export function canonicalDiagnosticScoreFactors(
  objectId: string,
  activation: number,
  params: FineAssessParams
): RecallScoreFactors {
  const scores = params.supplementaryData.embeddingSimilarityScores;
  const embedding = Object.hasOwn(scores, objectId) && Number.isFinite(scores[objectId])
    ? clamp01(scores[objectId]!)
    : undefined;
  return Object.freeze({
    activation: normalizeActivationScore(activation),
    relevance: 0,
    ...(embedding === undefined ? {} : { embedding_similarity: embedding })
  });
}
