import { createHash } from "node:crypto";
import { createCanonicalSelectionReceipt } from "@do-soul/alaya-protocol";
import { buildQuestionDiagnostic } from "../../../bench/diagnostics.js";

export const PLANTED_GOLD_ID = "planted-gold";
export const PLANTED_A_ID = "planted-a";
export const PLANTED_B_ID = "planted-b";
export const PLANTED_C_ID = "planted-c";
export const PLANTED_D_ID = "planted-d";
export const PLANTED_E_ID = "planted-e";

export function plantedCandidateKey(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

export function plantedCanonicalReceipt(input: {
  readonly objectIds: readonly string[];
  readonly deliveredObjectIds: readonly string[];
}) {
  const keys = input.objectIds.map(plantedCandidateKey);
  const deliveredKeys = input.deliveredObjectIds.map(plantedCandidateKey);
  const remaining = keys.filter((key) => !deliveredKeys.includes(key));
  const decisions = [...deliveredKeys, ...remaining];
  const observations = Object.fromEntries(
    keys.map((key) => [key, { h_gate: "none" as const, lineages: {} }])
  );
  return createCanonicalSelectionReceipt({
    schema_version: 1 as const,
    ranking_authority: "prefix_sk" as const,
    identity: {
      algorithm_id: "alaya.recall.shadow.safe-dominance-capture.v1" as const,
      version: "safe-dominance-capture.v1.0.0" as const,
      digest: "db68fc1dbd2f3e2a71dab08df7feb86c683de12c54ccdc10edfb17916dcef0e3" as const
    },
    execution: { status: "captured" as const, reason: null },
    field_membership: {
      e0_keys: keys,
      e1_keys: keys,
      eligible_keys: keys
    },
    observations_by_candidate_key: observations,
    frontiers: {
      schema_version: 1,
      operator_id: "shadow.frontiers.peel_undominated.v1",
      layers: [{ index: 1, member_keys: keys }]
    },
    gamma: {
      set_utilities: keys.map((key, index) => plantedUtility(key, input.objectIds[index]!)),
      decisions: decisions.map((key, index) => plantedDecision(key, index + 1)),
      rejects: []
    },
    dispositions: keys.map((key) => ({
      candidate_key: key,
      status: "selected" as const,
      reason: "selected_by_gamma" as const
    })),
    delivery: deliveredKeys.map((key, index) => ({
      candidate_key: key,
      delivery_rank: index + 1
    }))
  }, (preimage) => createHash("sha256").update(preimage, "utf8").digest("hex"));
}

export function plantedCanonicalRow(input: {
  readonly receipt: ReturnType<typeof plantedCanonicalReceipt>;
  readonly objectId: string;
  readonly deliveredRank: number | null;
  readonly admissionPlanes?: readonly string[];
}) {
  const candidateKey = plantedCandidateKey(input.objectId);
  const disposition = input.receipt.dispositions.find(
    (row) => row.candidate_key === candidateKey
  );
  if (disposition === undefined) {
    throw new Error(`missing planted disposition for ${candidateKey}`);
  }
  const planes = input.admissionPlanes ?? ["lexical"];
  return {
    schema_version: 1 as const,
    ranking_authority: "prefix_sk" as const,
    capture_receipt_digest: input.receipt.receipt_digest,
    legacy_selection: {
      fusion: "not_applicable" as const,
      deep_head: "not_applicable" as const,
      coverage: "not_applicable" as const
    },
    object_id: input.objectId,
    object_kind: "memory_entry" as const,
    candidate_key: candidateKey,
    origin_plane: "workspace_local" as const,
    created_at: "2026-07-11T00:00:00.000Z",
    dimension: "procedure",
    admission_planes: planes,
    plane_first_admitted: planes[0] ?? "lexical",
    plane_winning_admission: planes[0] ?? "lexical",
    admission_attempts: [],
    final_rank: input.deliveredRank,
    post_rank: input.deliveredRank,
    in_final_packet: input.deliveredRank !== null,
    eviction_reason: null,
    dropped_reason: null,
    within_budget: input.deliveredRank !== null,
    source_channels: ["local_lexical"],
    capture_disposition: disposition
  };
}

export function plantedCanonicalQuestion(input: {
  readonly questionId: string;
  readonly goldObjectId?: string;
  readonly fieldObjectIds: readonly string[];
  readonly deliveredObjectIds: readonly string[];
  readonly includeGoldCandidateRow?: boolean;
  readonly goldAdmissionPlanes?: readonly string[];
}) {
  const goldObjectId = input.goldObjectId ?? PLANTED_GOLD_ID;
  const receipt = plantedCanonicalReceipt({
    objectIds: input.fieldObjectIds,
    deliveredObjectIds: input.deliveredObjectIds
  });
  const deliveredRankById = new Map(
    input.deliveredObjectIds.map((objectId, index) => [objectId, index + 1] as const)
  );
  const includeGoldRow = input.includeGoldCandidateRow !== false;
  const rows = input.fieldObjectIds.flatMap((objectId) => {
    if (objectId === goldObjectId && !includeGoldRow) return [];
    return [plantedCanonicalRow({
      receipt,
      objectId,
      deliveredRank: deliveredRankById.get(objectId) ?? null,
      admissionPlanes: objectId === goldObjectId ? input.goldAdmissionPlanes : undefined
    })];
  });
  return buildQuestionDiagnostic({
    questionId: input.questionId,
    goldMemoryIds: [goldObjectId],
    answerSessionIds: ["session-planted"],
    deliveredResults: input.deliveredObjectIds.map((objectId, index) => ({
      object_id: objectId,
      rank: index + 1,
      relevance_score: 0.5
    })),
    hitAt1: deliveredRankById.get(goldObjectId) === 1,
    hitAt5: (deliveredRankById.get(goldObjectId) ?? 99) <= 5,
    hitAt10: (deliveredRankById.get(goldObjectId) ?? 99) <= 10,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: {
      ranking_authority: "prefix_sk",
      diagnostics: {
        capture_receipt: receipt,
        candidate_pool_count: rows.length,
        fine_assessment_pruned_candidates: [],
        token_economy: {
          fine_pruned_count: 0,
          fine_evaluated: rows.length,
          coarse_pool_size: rows.length
        },
        candidates: rows
      }
    }
  });
}

function plantedUtility(candidateKey: string, objectId: string) {
  return {
    schema_version: 1 as const,
    candidate_key: candidateKey,
    object_key: `object:${objectId}`,
    obligations: [],
    matches: [],
    values: { status: "unavailable" as const, values: [] },
    cid: { status: "unavailable" as const },
    availability: {
      facility: "not_applicable" as const,
      values: "unavailable" as const,
      evidence_identity: "unavailable" as const
    }
  };
}

function plantedDecision(candidateKey: string, frontierIndex: number) {
  return {
    schema_version: 1 as const,
    candidate_key: candidateKey,
    capture_reason: "core_undominated" as const,
    G: { unscaled_remainder: 0, Values_v: 0, evidence_novelty_redundancy: 0 as const },
    G_status: {
      facility: "not_applicable" as const,
      values: "unavailable" as const,
      evidence_identity: "unavailable" as const
    },
    named_novelty: { facility_keys: [], value_pairs: [], content_ids: [] },
    novelty_core_known_absence: [],
    max_g_cohort: [candidateKey],
    equal_g_dominance_rejects: [],
    deterministic_tail: "candidate_key_code_unit_ascending" as const,
    unresolved_pointwise_tradeoff: false,
    h_gate: "none" as const,
    walk_reject: "none" as const,
    static_frontier_index: frontierIndex
  };
}
