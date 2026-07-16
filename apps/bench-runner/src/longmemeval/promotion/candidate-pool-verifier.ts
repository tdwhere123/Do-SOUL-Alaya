import type {
  FineAssessmentPrunedCandidateDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate
} from "../diagnostics-types.js";
import {
  buildDiagnosticCandidateKey,
  buildObjectIdentityKey,
  readDiagnosticObjectKind,
  readRecallOriginPlane
} from "../diagnostics/candidate-identity.js";
import {
  isPreferredCandidateManifestation,
  type CandidateManifestationOrderKey
} from "../diagnostics/candidate-manifestation-order.js";

export interface VerifiedPromotionCandidatePool {
  readonly scoredByIdentity: ReadonlyMap<string, LongMemEvalReplayCandidate>;
  readonly finePrunedByIdentity:
    ReadonlyMap<string, FineAssessmentPrunedCandidateDiagnostic>;
  readonly finePrunedObjectIds: ReadonlySet<string>;
}

export function verifyPromotionCandidatePoolClosure(
  question: LongMemEvalQuestionDiagnostic
): VerifiedPromotionCandidatePool {
  const scored = indexScoredCandidates(question);
  const finePrunedByIdentity = new Map<
    string,
    FineAssessmentPrunedCandidateDiagnostic
  >();
  const finePrunedObjectIds = new Set<string>();
  const fineKeys = indexFinePrunedCandidates(
    question,
    finePrunedByIdentity,
    finePrunedObjectIds
  );
  const countClosed = question.candidate_pool_count ===
    scored.keys.size + fineKeys.size;
  if (!countClosed || question.fine_pruned_count !== fineKeys.size ||
      question.candidate_pool_complete !== true ||
      question.cohort_ledger?.candidate_pool_complete !== true ||
      hasOverlap(scored.keys, fineKeys)) {
    throw new Error(`recall-eval candidate pool closure differs for ${question.question_id}`);
  }
  return Object.freeze({
    scoredByIdentity: Object.freeze(scored.byIdentity),
    finePrunedByIdentity: Object.freeze(finePrunedByIdentity),
    finePrunedObjectIds: Object.freeze(finePrunedObjectIds)
  });
}

function indexScoredCandidates(
  question: LongMemEvalQuestionDiagnostic
): {
  readonly byIdentity: Map<string, LongMemEvalReplayCandidate>;
  readonly keys: ReadonlySet<string>;
} {
  if (question.candidate_key_collisions.length > 0) {
    throw new Error(`recall-eval candidate pool closure collides for ${question.question_id}`);
  }
  const byIdentity = new Map<string, LongMemEvalReplayCandidate>();
  const candidateKeys = new Set<string>();
  for (const candidate of question.candidates) {
    const objectKind = candidate.object_kind;
    const identity = buildObjectIdentityKey(objectKind, candidate.object_id);
    if (candidateKeys.has(candidate.candidate_key) || !hasExactCandidateKey(candidate)) {
      throw new Error(`recall-eval candidate pool closure repeats candidate ${candidate.candidate_key}`);
    }
    candidateKeys.add(candidate.candidate_key);
    const existing = byIdentity.get(identity);
    if (existing === undefined || isPreferredCandidateManifestation(
      toManifestationOrderKey(candidate),
      toManifestationOrderKey(existing)
    )) {
      byIdentity.set(identity, candidate);
    }
  }
  return { byIdentity, keys: candidateKeys };
}

function indexFinePrunedCandidates(
  question: LongMemEvalQuestionDiagnostic,
  byIdentity: Map<string, FineAssessmentPrunedCandidateDiagnostic>,
  objectIds: Set<string>
): ReadonlySet<string> {
  const keys = new Set<string>();
  let previousIndex = -1;
  for (const candidate of question.fine_assessment_pruned_candidates) {
    const identity = buildObjectIdentityKey(candidate.object_kind, candidate.object_id);
    if (keys.has(candidate.candidate_key) || !hasExactCandidateKey(candidate) ||
        candidate.coarse_index <= previousIndex ||
        question.candidate_pool_count === null ||
        candidate.coarse_index >= question.candidate_pool_count) {
      throw new Error(`recall-eval candidate pool closure repeats ${candidate.candidate_key}`);
    }
    previousIndex = candidate.coarse_index;
    keys.add(candidate.candidate_key);
    if (!byIdentity.has(identity)) byIdentity.set(identity, candidate);
    objectIds.add(candidate.object_id);
  }
  return keys;
}

function hasExactCandidateKey(candidate: Readonly<{
  readonly candidate_key: string;
  readonly origin_plane: unknown;
  readonly object_kind: unknown;
  readonly object_id: string;
}>): boolean {
  const originPlane = readRecallOriginPlane(candidate.origin_plane);
  const objectKind = readDiagnosticObjectKind(candidate.object_kind);
  return originPlane !== null && objectKind !== null && candidate.candidate_key ===
    buildDiagnosticCandidateKey(originPlane, objectKind, candidate.object_id);
}

function toManifestationOrderKey(
  candidate: LongMemEvalReplayCandidate
): CandidateManifestationOrderKey {
  return {
    finalRank: candidate.final_rank,
    fusedRank: candidate.fused_rank,
    originPlane: candidate.origin_plane,
    candidateKey: candidate.candidate_key
  };
}

function hasOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const key of left) if (right.has(key)) return true;
  return false;
}
