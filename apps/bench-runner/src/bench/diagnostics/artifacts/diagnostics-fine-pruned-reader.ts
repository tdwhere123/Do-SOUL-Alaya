import type { FineAssessmentPrunedCandidateDiagnostic } from "../schema/diagnostics-types.js";
import {
  buildDiagnosticCandidateKey,
  readDiagnosticObjectKind,
  readRecallOriginPlane
} from "../candidate-identity.js";

export interface FineAssessmentPrunedClosure {
  readonly complete: boolean;
  readonly candidatePoolCount: number | null;
  readonly finePrunedCount: number | null;
  readonly candidates: readonly FineAssessmentPrunedCandidateDiagnostic[];
  readonly byObjectIdentity:
    ReadonlyMap<string, FineAssessmentPrunedCandidateDiagnostic>;
  readonly objectIds: ReadonlySet<string>;
}

export function readFineAssessmentPrunedClosure(
  diagnostics: Readonly<Record<string, unknown>>,
  scoredCandidateKeys: ReadonlySet<string>
): FineAssessmentPrunedClosure {
  const source = Array.isArray(diagnostics.fine_assessment_pruned_candidates)
    ? diagnostics.fine_assessment_pruned_candidates
    : null;
  const candidatePoolCount = readNonNegativeInteger(diagnostics.candidate_pool_count);
  const economy = readRecord(diagnostics.token_economy);
  const finePrunedCount = readNonNegativeInteger(economy?.fine_pruned_count);
  const fineEvaluated = readNonNegativeInteger(economy?.fine_evaluated);
  const coarsePoolSize = readNonNegativeInteger(economy?.coarse_pool_size);
  const candidates = (source ?? []).flatMap((raw) => {
    const parsed = readPrunedCandidate(raw);
    return parsed === null ? [] : [parsed];
  });
  const keys = new Set(candidates.map((candidate) => candidate.candidate_key));
  const complete = source !== null && candidates.length === source.length &&
    keys.size === candidates.length && !hasOverlap(keys, scoredCandidateKeys) &&
    hasOrderedCoarseIndexes(candidates, candidatePoolCount) &&
    candidatePoolCount === scoredCandidateKeys.size + candidates.length &&
    finePrunedCount === candidates.length && fineEvaluated === scoredCandidateKeys.size &&
    coarsePoolSize === candidatePoolCount;
  return buildClosureResult(
    complete, candidatePoolCount, finePrunedCount, candidates
  );
}

function readPrunedCandidate(
  value: unknown
): FineAssessmentPrunedCandidateDiagnostic | null {
  const record = readRecord(value);
  if (record === null) return null;
  const candidateKey = readString(record.candidate_key);
  const objectId = readString(record.object_id);
  const objectKind = readDiagnosticObjectKind(record.object_kind);
  const originPlane = readRecallOriginPlane(record.origin_plane);
  const coarseIndex = readNonNegativeInteger(record.coarse_index);
  if (candidateKey === null || objectId === null || coarseIndex === null ||
      objectKind === null || originPlane === null ||
      record.drop_reason !== "fine_assessment_cap" ||
      candidateKey !== buildDiagnosticCandidateKey(originPlane, objectKind, objectId)) return null;
  return Object.freeze({
    candidate_key: candidateKey,
    origin_plane: originPlane,
    object_kind: objectKind,
    object_id: objectId,
    coarse_index: coarseIndex,
    drop_reason: "fine_assessment_cap"
  });
}

function buildClosureResult(
  complete: boolean,
  candidatePoolCount: number | null,
  finePrunedCount: number | null,
  candidates: readonly FineAssessmentPrunedCandidateDiagnostic[]
): FineAssessmentPrunedClosure {
  const byObjectIdentity = new Map<string, FineAssessmentPrunedCandidateDiagnostic>();
  const objectIds = new Set<string>();
  for (const candidate of candidates) {
    const identity = `${candidate.object_kind}:${candidate.object_id}`;
    if (!byObjectIdentity.has(identity)) byObjectIdentity.set(identity, candidate);
    objectIds.add(candidate.object_id);
  }
  return Object.freeze({
    complete,
    candidatePoolCount,
    finePrunedCount,
    candidates: Object.freeze([...candidates]),
    byObjectIdentity: Object.freeze(byObjectIdentity),
    objectIds: Object.freeze(objectIds)
  });
}

function hasOrderedCoarseIndexes(
  candidates: readonly FineAssessmentPrunedCandidateDiagnostic[],
  candidatePoolCount: number | null
): boolean {
  if (candidatePoolCount === null) return false;
  let previous = -1;
  for (const candidate of candidates) {
    if (candidate.coarse_index <= previous ||
        candidate.coarse_index >= candidatePoolCount) return false;
    previous = candidate.coarse_index;
  }
  return true;
}

function hasOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const key of left) if (right.has(key)) return true;
  return false;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
