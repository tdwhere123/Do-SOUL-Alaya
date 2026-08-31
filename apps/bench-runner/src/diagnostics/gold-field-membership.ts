import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate
} from "./schema/diagnostics-types.js";
import type { NarrowRecallDiagnostics } from "./schema/narrow-recall-diagnostics.js";

export interface GoldFieldIdentity {
  readonly object_id: string;
  readonly object_kind?: string | null;
}

export interface GoldFieldCandidateIdentity {
  readonly object_id: string;
  readonly candidate_key: string;
}

export interface GoldFieldContext {
  readonly fieldKeys: readonly string[];
  readonly candidateIdentities: readonly GoldFieldCandidateIdentity[];
}

export function emptyGoldFieldContext(): GoldFieldContext {
  return { fieldKeys: [], candidateIdentities: [] };
}

export function readDiagnosticsFieldContext(
  diagnostics: NarrowRecallDiagnostics | null
): GoldFieldContext {
  if (diagnostics === null) return emptyGoldFieldContext();
  return {
    fieldKeys: diagnostics.captureReceipt?.field_membership.e0_keys ?? [],
    candidateIdentities: [...diagnostics.candidatesByCandidateKey.values()].map((row) => ({
      object_id: row.objectId,
      candidate_key: row.candidateKey
    }))
  };
}

export function readQuestionFieldContext(
  question: Pick<LongMemEvalQuestionDiagnostic, "capture_receipt" | "candidates">
): GoldFieldContext {
  return {
    fieldKeys: question.capture_receipt?.field_membership.e0_keys ?? [],
    candidateIdentities: replayCandidateIdentities(question.candidates)
  };
}

export function isGoldInField(
  gold: GoldFieldIdentity & Pick<
    LongMemEvalGoldDiagnostic,
    "candidate_status" | "final_rank"
  >,
  field: GoldFieldContext
): boolean {
  if (
    gold.candidate_status === "delivered" ||
    gold.candidate_status === "candidate_not_delivered"
  ) {
    return true;
  }
  if (gold.final_rank !== null) return true;
  return goldIdentityInFieldKeys(gold, field);
}

export function isFieldOrderingMiss(
  gold: GoldFieldIdentity & Pick<
    LongMemEvalGoldDiagnostic,
    "candidate_status" | "final_rank"
  >,
  field: GoldFieldContext
): boolean {
  if (gold.candidate_status === "active_constraint_delivered") return false;
  return isGoldInField(gold, field);
}

export function goldIdentityInFieldKeys(
  gold: GoldFieldIdentity,
  field: GoldFieldContext
): boolean {
  if (field.fieldKeys.length === 0) return false;
  const keys = new Set(field.fieldKeys);
  for (const row of field.candidateIdentities) {
    if (row.object_id === gold.object_id && keys.has(row.candidate_key)) return true;
  }
  const kind = gold.object_kind ?? "memory_entry";
  const suffix = `:${kind}:${gold.object_id}`;
  return field.fieldKeys.some((key) => key.endsWith(suffix));
}

function replayCandidateIdentities(
  candidates: readonly LongMemEvalReplayCandidate[] | undefined
): readonly GoldFieldCandidateIdentity[] {
  if (candidates === undefined) return [];
  return candidates.map((row) => ({
    object_id: row.object_id,
    candidate_key: row.candidate_key
  }));
}
