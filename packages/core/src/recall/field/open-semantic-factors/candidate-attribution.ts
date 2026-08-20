import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate, RecallSupplementaryData } from
  "../../runtime/recall-service-types.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from "../field-identity.js";
import type {
  OpenSemanticFactorActivationReceipt,
  OpenSemanticFactorActivationState
} from "./activation.js";
import { compareText } from "../../../shared/compare-text.js";

export const OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID =
  "open_semantic_factor_candidate_activation_v1";

export type OpenSemanticFactorCandidateActivation = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID;
  readonly state: OpenSemanticFactorActivationState;
  readonly score: number;
  readonly evidence_ids: readonly string[];
  readonly solution_count: number;
  readonly proposition_match_count: number;
  readonly receipt_digest: RecallFieldDigest;
}>;

export function attributeOpenSemanticFactorActivations(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly activation: Readonly<OpenSemanticFactorActivationReceipt>;
}>): ReadonlyMap<string, Readonly<OpenSemanticFactorCandidateActivation>> {
  if (params.activation.status !== "composed" || params.activation.truncated) {
    return new Map();
  }
  const supportByEvidenceId = new Map(params.activation.entries.map((entry) => [
    entry.evidence_id,
    entry
  ] as const));
  const attributed = new Map<string, Readonly<OpenSemanticFactorCandidateActivation>>();
  for (const candidate of params.candidates) {
    const evidenceIds = candidateEvidenceIds(candidate)
      .filter((evidenceId) => supportByEvidenceId.has(evidenceId))
      .sort(compareText);
    if (evidenceIds.length === 0) continue;
    const entries = evidenceIds.map((evidenceId) => supportByEvidenceId.get(evidenceId)!);
    const body = Object.freeze({
      schema_version: 1 as const,
      operator_id: OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID,
      state: entries.some((entry) => entry.state === "reconstructed")
        ? "reconstructed" as const
        : "observed" as const,
      score: Math.max(...entries.map((entry) => entry.activation)),
      evidence_ids: Object.freeze(evidenceIds),
      solution_count: Math.max(...entries.map((entry) => entry.solution_count)),
      proposition_match_count: Math.max(
        ...entries.map((entry) => entry.proposition_match_count)
      )
    });
    attributed.set(
      buildRecallCandidateDedupeKey(candidate),
      Object.freeze({
        ...body,
        receipt_digest: digestRecallFieldIdentity(body)
      })
    );
  }
  return attributed;
}

function candidateEvidenceIds(candidate: Readonly<CoarseRecallCandidate>): readonly string[] {
  if (candidate.objectKind === "evidence_capsule") {
    return [candidate.entry.object_id];
  }
  if (!isWorkspaceMemoryCandidate(candidate)) return [];
  return [...new Set(candidate.entry.evidence_refs)];
}


export type OpenSemanticFactorCandidateActivationSupplement = Pick<
  RecallSupplementaryData,
  "openSemanticFactorCandidateActivationsByCandidateKey"
>;
