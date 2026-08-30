import type {
  CanonicalDisposition,
  CanonicalSelectionReceipt,
  RecallCandidate,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { ShadowContractError } from "../../decision/contract-primitives.js";
import { clamp01 } from "../../../shared/clamp.js";
import {
  buildRecallCandidateDedupeKey,
  normalizeActivationScore
} from "../recall-service-helpers.js";
import type {
  CanonicalCandidateDiagnostic
} from "../recall-service-types.js";
import type { FineAssessParams } from "../../delivery/fine-assessment.js";

export function buildCanonicalDeliveryDiagnostics(
  params: FineAssessParams,
  delivered: readonly Readonly<RecallCandidate>[],
  receipt: Readonly<CanonicalSelectionReceipt>
): readonly CanonicalCandidateDiagnostic[] {
  const dispositions = receipt.dispositions;
  const deliveredRank = new Map(delivered.map((candidate, index) => [
    `${candidate.origin_plane}:${candidate.object_kind}:${candidate.object_id}`,
    index + 1
  ]));
  return Object.freeze(params.candidates.map((coarse) => {
    const key = buildRecallCandidateDedupeKey(coarse);
    const rank = deliveredRank.get(key);
    const disposition = dispositions.find((row) => row.candidate_key === key);
    if (disposition === undefined) {
      throw new ShadowContractError("canonical diagnostic disposition is missing");
    }
    const inPacket = rank !== undefined;
    const dropped = dropReason(disposition, inPacket);
    const planes = Object.freeze([
      ...(coarse.admissionPlanes ?? ["activation" as const])
    ]);
    return Object.freeze({
      schema_version: 1 as const,
      ranking_authority: "prefix_sk" as const,
      capture_receipt_digest: receipt.receipt_digest,
      capture_disposition: disposition,
      legacy_selection: Object.freeze({
        fusion: "not_applicable" as const,
        deep_head: "not_applicable" as const,
        coverage: "not_applicable" as const
      }),
      candidate_key: key,
      object_id: coarse.entry.object_id,
      object_kind: coarse.objectKind ?? "memory_entry",
      created_at: coarse.entry.created_at,
      dimension: coarse.entry.dimension,
      origin_plane: coarse.originPlane ?? "workspace_local",
      admission_planes: planes,
      plane_first_admitted: coarse.firstAdmissionPlane ?? planes[0] ?? "activation",
      plane_winning_admission: planes[0] ?? "activation",
      admission_attempts: Object.freeze([]),
      final_rank: rank ?? null,
      post_rank: rank ?? null,
      in_final_packet: inPacket,
      eviction_reason: dropped,
      dropped_reason: dropped,
      within_budget: inPacket,
      source_channels: Object.freeze([
        ...(coarse.sourceChannels ??
          (coarse.sourceChannel === undefined ? [] : [coarse.sourceChannel]))
      ])
    });
  }));
}

function dropReason(
  disposition: Readonly<CanonicalDisposition>,
  delivered: boolean
): "ineligible" | "duplicate" | "dimension_limit" | "max_entries" |
  "max_total_tokens" | null {
  if (delivered) return null;
  if (disposition.status === "selected") return "max_entries";
  if (disposition.status === "ineligible") return "ineligible";
  if (disposition.status === "unavailable") return null;
  if (disposition.reason === "duplicate_object") return "duplicate";
  if (disposition.reason === "dimension_limit") return "dimension_limit";
  return "max_total_tokens";
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
