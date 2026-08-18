import type { FineAssessmentPreProjectionObservation } from
  "../selection-boundary-types.js";
import { selectionBoundaryJsonSha256 } from
  "../selection-boundary-json.js";
import { throwSelectionBoundaryFidelityMismatch } from
  "../validation/fidelity-error.js";
import { isRecord } from "../record-guards.js";
import { completeFineAssessmentPreProjection } from "./observation.js";

export function assertPreProjection(
  observation: unknown,
  deliveredCandidateKeys: readonly string[]
): void {
  const parsed = parsePreProjection(observation);
  assertUniqueKeys(parsed.candidate_keys);
  assertUniqueKeys(parsed.admission_actions.map((action) => action.candidate_key));
  assertUniqueKeys(parsed.projection_actions.map((action) => action.candidate_key));
  assertUniqueKeys(parsed.introduced_candidate_keys);
  assertAdmissionActions(parsed);
  assertProjectionActions(parsed, deliveredCandidateKeys);
}

function parsePreProjection(
  observation: unknown
): FineAssessmentPreProjectionObservation {
  if (!isPreProjectionObservation(observation)) {
    throwSelectionBoundaryFidelityMismatch(
      "expected pre_projection schema_version=1 with action arrays, actual invalid"
    );
  }
  if (observation.admission_actions.some((action) => !isRecord(action)) ||
      observation.projection_actions.some((action) => !isRecord(action))) {
    throwSelectionBoundaryFidelityMismatch(
      "expected record admission/projection actions, actual non-record"
    );
  }
  return observation;
}

function isPreProjectionObservation(
  value: unknown
): value is FineAssessmentPreProjectionObservation {
  return isRecord(value) && value.schema_version === 1 &&
    Array.isArray(value.candidate_keys) &&
    Array.isArray(value.admission_actions) &&
    Array.isArray(value.projection_actions) &&
    Array.isArray(value.introduced_candidate_keys) &&
    isNonNegativeFinite(value.token_total) &&
    typeof value.ordered_subsequence === "boolean" &&
    typeof value.qualified_ordered_subsequence === "boolean";
}

function assertAdmissionActions(
  parsed: FineAssessmentPreProjectionObservation
): void {
  let retainedIndex = 0;
  let retainedTokenTotal = 0;
  for (const [index, action] of parsed.admission_actions.entries()) {
    if (!Number.isInteger(action.selection_order) ||
        action.selection_order !== index + 1) {
      throwSelectionBoundaryFidelityMismatch(
        `expected admission selection_order=${index + 1}, actual ${String(action.selection_order)}`
      );
    }
    const next = applyAdmissionAction(
      parsed, action, retainedIndex, retainedTokenTotal
    );
    retainedIndex = next.retainedIndex;
    retainedTokenTotal = next.retainedTokenTotal;
  }
  if (retainedIndex !== parsed.candidate_keys.length ||
      retainedTokenTotal !== parsed.token_total) {
    throwSelectionBoundaryFidelityMismatch(
      `expected retainedIndex=${parsed.candidate_keys.length} ` +
      `token_total=${parsed.token_total}, actual retainedIndex=${retainedIndex} ` +
      `token_total=${retainedTokenTotal}`
    );
  }
}

function applyAdmissionAction(
  parsed: FineAssessmentPreProjectionObservation,
  action: FineAssessmentPreProjectionObservation["admission_actions"][number],
  retainedIndex: number,
  retainedTokenTotal: number
): { retainedIndex: number; retainedTokenTotal: number } {
  if (action.action === "retain") {
    const nextIndex = retainedIndex + 1;
    if (action.dropped_reason !== null ||
        action.pre_projection_rank !== nextIndex ||
        parsed.candidate_keys[nextIndex - 1] !== action.candidate_key) {
      throwSelectionBoundaryFidelityMismatch(
        `expected retain rank=${nextIndex} matching candidate_keys, ` +
        `actual rank=${String(action.pre_projection_rank)}`
      );
    }
    return {
      retainedIndex: nextIndex,
      retainedTokenTotal: assertRetainedWitness(
        action.witness, nextIndex - 1, retainedTokenTotal
      )
    };
  }
  if (action.action !== "exclude" || action.dropped_reason === null ||
      action.pre_projection_rank !== null ||
      !witnessMatchesExclusion(action.witness, action.dropped_reason)) {
    throwSelectionBoundaryFidelityMismatch(
      `expected exclude with dropped_reason witness, actual action=${String(action.action)}`
    );
  }
  return { retainedIndex, retainedTokenTotal };
}

function assertProjectionActions(
  observation: FineAssessmentPreProjectionObservation,
  deliveredCandidateKeys: readonly string[]
): void {
  const expected = completeFineAssessmentPreProjection({
    schema_version: observation.schema_version,
    candidate_keys: observation.candidate_keys,
    token_total: observation.token_total,
    admission_actions: observation.admission_actions
  }, deliveredCandidateKeys);
  const expectedDigest = selectionBoundaryJsonSha256(expected);
  const actualDigest = selectionBoundaryJsonSha256(observation);
  if (expectedDigest !== actualDigest) {
    throwSelectionBoundaryFidelityMismatch(
      `expected pre_projection digest ${expectedDigest}, actual ${actualDigest}`
    );
  }
}

function assertRetainedWitness(
  witness: unknown,
  selectedCountBefore: number,
  tokenTotalBefore: number
): number {
  if (!isRecord(witness) || witness.kind !== "retained" ||
      witness.selected_count_before !== selectedCountBefore ||
      witness.token_total_before !== tokenTotalBefore ||
      !isNonNegativeFinite(witness.token_estimate) ||
      !isIdentityChannel(witness.source) ||
      !isIdentityChannel(witness.lineage)) {
    throwSelectionBoundaryFidelityMismatch(
      `expected retained witness selected_count_before=${selectedCountBefore} ` +
      `token_total_before=${tokenTotalBefore}, actual invalid`
    );
  }
  return tokenTotalBefore + witness.token_estimate;
}

function isIdentityChannel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return value.status === "unavailable"
    ? keys.length === 1
    : value.status === "available" && isNonEmptyString(value.key) &&
      keys.length === 2;
}

function witnessMatchesExclusion(witness: unknown, reason: string): boolean {
  if (!isRecord(witness) || witness.kind !== reason) return false;
  if (reason === "ineligible") {
    return isEligibilityState(witness.risk) &&
      isEligibilityState(witness.authority) &&
      (witness.risk === "blocked" || witness.authority === "blocked");
  }
  if (reason === "duplicate") {
    return (witness.identity_channel === "object" ||
      witness.identity_channel === "source" ||
      witness.identity_channel === "lineage") &&
      isNonEmptyString(witness.retained_candidate_key);
  }
  if (reason === "dimension_limit") {
    return isNonEmptyString(witness.dimension) &&
      isNonNegativeInteger(witness.accepted_before) &&
      isNonNegativeInteger(witness.limit);
  }
  if (reason === "max_entries") {
    return isNonNegativeInteger(witness.accepted_before) &&
      isNonNegativeInteger(witness.limit);
  }
  if (reason === "max_total_tokens") {
    return isNonNegativeFinite(witness.token_total_before) &&
      isNonNegativeFinite(witness.token_estimate) &&
      isNonNegativeFinite(witness.limit);
  }
  return false;
}

function isEligibilityState(value: unknown): value is "clear" | "blocked" {
  return value === "clear" || value === "blocked";
}

function assertUniqueKeys(keys: readonly string[]): void {
  const emptyOrNonString = keys.filter(
    (key) => typeof key !== "string" || key.length === 0
  ).length;
  const unique = new Set(keys).size;
  if (emptyOrNonString !== 0 || unique !== keys.length) {
    throwSelectionBoundaryFidelityMismatch(
      `expected unique non-empty keys, actual count=${keys.length} ` +
      `unique=${unique} empty_or_nonstring=${emptyOrNonString}`
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
