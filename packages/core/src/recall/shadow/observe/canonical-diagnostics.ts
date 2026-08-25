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
  const byKey = new Map(params.candidates.map((candidate) => [
    buildRecallCandidateDedupeKey(candidate),
    candidate
  ]));
  return Object.freeze(delivered.map((deliveredCandidate, index) => {
    const key = `${deliveredCandidate.origin_plane}:${deliveredCandidate.object_kind}:${deliveredCandidate.object_id}`;
    const coarse = byKey.get(key);
    const order = index + 1;
    const planes = Object.freeze([
      ...(coarse?.admissionPlanes ?? ["activation" as const])
    ]);
    return Object.freeze({
      candidate_key: key,
      object_id: deliveredCandidate.object_id,
      object_kind: deliveredCandidate.object_kind,
      created_at: coarse?.entry.created_at ?? params.now(),
      dimension: deliveredCandidate.dimension,
      origin_plane: deliveredCandidate.origin_plane,
      admission_planes: planes,
      plane_first_admitted: coarse?.firstAdmissionPlane ?? planes[0] ?? "activation",
      plane_winning_admission: planes[0] ?? "activation",
      pre_budget_rank: order,
      selection_order: order,
      admission_attempts: Object.freeze([{
        pass: "final_selector" as const,
        selection_order: order,
        admitted: true,
        dropped_reason: null
      }]),
      evidence_projection_matches: Object.freeze([]),
      fused_rank: order,
      fused_score: 0,
      per_stream_rank: EMPTY_STREAM_RANKS,
      fused_rank_contribution_per_stream: EMPTY_STREAM_CONTRIBUTIONS,
      final_rank: order,
      post_rank: order,
      in_final_packet: true,
      eviction_reason: null,
      dropped_reason: null,
      within_budget: true,
      relevance_score: 0,
      additive_score: 0,
      lexical_rank: null,
      structural_score: 0,
      score_factors: canonicalDiagnosticScoreFactors(
        deliveredCandidate.object_id,
        deliveredCandidate.activation_score,
        params
      ),
      source_channels: Object.freeze([
        ...(deliveredCandidate.source_channels ?? [])
      ]),
      path_expansion_sources: Object.freeze([]),
      path_suppression_score: 0,
      rank_after_coverage_selector: order,
      coverage_selector_action: "kept" as const,
      session_key: coarse?.entry.surface_id ?? coarse?.entry.run_id ?? "<no-session>"
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
