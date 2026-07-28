import { deepFreeze } from "../../../shared/deep-freeze.js";
import { CoreError } from "../../../shared/errors.js";

export type RecallPacketPlanPath = "legacy" | "snapshot";

export type RecallPacketPlanDecision =
  | Readonly<{
      readonly status: "accepted";
      readonly reason: "strict_tail_consensus";
    }>
  | Readonly<{
      readonly status: "no_op";
      readonly reason: "no_finite_embedding_head" | "unchanged_consensus";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason:
        | "admission_infeasible"
        | "behavior_guard_full_abort"
        | "cardinality_mismatch"
        | "protected_candidate_constraint";
    }>;

export type RecallPacketPlanObservation = Readonly<{
  readonly baseline_candidate_keys: readonly string[];
  readonly planned_candidate_keys: readonly string[];
  readonly actual_candidate_keys: readonly string[];
  readonly head_width: number;
  readonly baseline_head_candidate_keys: readonly string[];
  readonly embedding_head: readonly Readonly<{
    readonly candidate_key: string;
    readonly embedding_rank: number;
  }>[];
  readonly consensus_head_candidate_keys: readonly string[];
  readonly immutable_tail_candidate_keys: readonly string[];
  readonly protected_candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly rank_limit: number;
  }>[];
  readonly decision: RecallPacketPlanDecision;
}>;

export type RecallPacketPlanTrace = Readonly<{
  readonly schema_version: 2;
  readonly assessment_path: RecallPacketPlanPath;
  readonly added_candidate_keys: readonly string[];
  readonly removed_candidate_keys: readonly string[];
}> & RecallPacketPlanObservation;

export function buildSupportSetPacketPlanTrace(
  assessmentPath: RecallPacketPlanPath,
  observation: RecallPacketPlanObservation
): RecallPacketPlanTrace {
  assertSupportSetObservation(observation);
  return deepFreeze({
    schema_version: 2,
    assessment_path: assessmentPath,
    ...observation,
    added_candidate_keys: deriveAddedKeys(
      observation.baseline_candidate_keys,
      observation.planned_candidate_keys
    ),
    removed_candidate_keys: deriveRemovedKeys(
      observation.baseline_candidate_keys,
      observation.planned_candidate_keys
    )
  });
}

function assertSupportSetObservation(
  observation: RecallPacketPlanObservation
): void {
  const baseline = observation.baseline_candidate_keys;
  const planned = observation.planned_candidate_keys;
  const actual = observation.actual_candidate_keys;
  const baselineHead = observation.baseline_head_candidate_keys;
  const consensusHead = observation.consensus_head_candidate_keys;
  const immutableTail = observation.immutable_tail_candidate_keys;
  assertUniqueKeys(baseline, "baseline");
  assertUniqueKeys(planned, "planned");
  assertUniqueKeys(actual, "actual");
  if (
    observation.head_width !== Math.ceil(baseline.length / 2) ||
    baselineHead.length !== observation.head_width ||
    (observation.decision.reason !== "cardinality_mismatch" &&
      consensusHead.length !== observation.head_width)
  ) {
    throw validationError("Packet plan head width is inconsistent");
  }
  if (!sameOrderedKeys(baseline, [...baselineHead, ...immutableTail])) {
    throw validationError("Packet plan baseline partition is inconsistent");
  }
  if (!sameOrderedKeys(planned, [...consensusHead, ...immutableTail])) {
    throw validationError("Packet plan proposal is inconsistent");
  }
  assertEmbeddingHead(observation);
  assertProtections(observation);
  assertDecisionReason(observation);
  assertDecision(observation, baseline, planned, actual);
}

function assertEmbeddingHead(observation: RecallPacketPlanObservation): void {
  assertUniqueKeys(
    observation.embedding_head.map((entry) => entry.candidate_key),
    "embedding head"
  );
  if (observation.embedding_head.some(
    (entry) => !Number.isInteger(entry.embedding_rank) ||
      entry.embedding_rank <= 0 ||
      entry.embedding_rank > observation.head_width
  )) {
    throw validationError("Embedding head rank exceeds packet head");
  }
}

function assertProtections(observation: RecallPacketPlanObservation): void {
  assertUniqueKeys(
    observation.protected_candidates.map((entry) => entry.candidate_key),
    "protected candidates"
  );
  if (observation.protected_candidates.some(
    (entry) => !Number.isInteger(entry.rank_limit) || entry.rank_limit <= 0
  )) {
    throw validationError("Packet protection rank limit is invalid");
  }
}

function assertDecision(
  observation: RecallPacketPlanObservation,
  baseline: readonly string[],
  planned: readonly string[],
  actual: readonly string[]
): void {
  if (observation.decision.status === "accepted" && !sameOrderedKeys(planned, actual)) {
    throw validationError("Accepted packet plan must match the actual packet");
  }
  if (observation.decision.status === "rejected" && !sameOrderedKeys(baseline, actual)) {
    throw validationError("Rejected packet plan must preserve the baseline packet");
  }
  if (
    observation.decision.status === "no_op" &&
    (!sameOrderedKeys(baseline, planned) || !sameOrderedKeys(baseline, actual))
  ) {
    throw validationError("No-op packet plan must preserve the baseline packet");
  }
}

function assertDecisionReason(
  observation: RecallPacketPlanObservation
): void {
  const reason = observation.decision.reason;
  const hasEmbeddingHead = observation.embedding_head.length > 0;
  const changed = !sameOrderedKeys(
    observation.baseline_head_candidate_keys,
    observation.consensus_head_candidate_keys
  );
  if (reason === "no_finite_embedding_head" && hasEmbeddingHead) {
    throw validationError("Absent embedding head decision contains ranked candidates");
  }
  if (
    reason === "unchanged_consensus" &&
    (!hasEmbeddingHead || changed)
  ) {
    throw validationError("Unchanged consensus decision is inconsistent");
  }
  if (
    ["strict_tail_consensus", "admission_infeasible",
      "behavior_guard_full_abort", "protected_candidate_constraint"].includes(reason) &&
    (!hasEmbeddingHead || !changed)
  ) {
    throw validationError("Changed consensus decision is inconsistent");
  }
  if (
    reason === "cardinality_mismatch" &&
    observation.consensus_head_candidate_keys.length === observation.head_width
  ) {
    throw validationError("Cardinality rejection has a complete consensus head");
  }
  assertProtectionDecision(observation);
}

function assertProtectionDecision(
  observation: RecallPacketPlanObservation
): void {
  const protectionsSatisfied = observation.protected_candidates.every(
    ({ candidate_key: candidateKey, rank_limit: rankLimit }) => {
      const rank = observation.planned_candidate_keys.indexOf(candidateKey) + 1;
      return rank > 0 && rank <= rankLimit;
    }
  );
  if (
    observation.decision.reason === "protected_candidate_constraint" &&
    protectionsSatisfied
  ) {
    throw validationError("Protection rejection contains no violated constraint");
  }
  if (
    ["strict_tail_consensus", "admission_infeasible"].includes(
      observation.decision.reason
    ) &&
    !protectionsSatisfied
  ) {
    throw validationError("Accepted consensus violates a protected candidate");
  }
}

function assertUniqueKeys(keys: readonly string[], label: string): void {
  if (new Set(keys).size !== keys.length) {
    throw validationError(`Packet plan ${label} contains duplicate keys`);
  }
}

function deriveAddedKeys(
  baselineKeys: readonly string[],
  plannedKeys: readonly string[]
): readonly string[] {
  const baselineSet = new Set(baselineKeys);
  return plannedKeys.filter((candidateKey) => !baselineSet.has(candidateKey));
}

function deriveRemovedKeys(
  baselineKeys: readonly string[],
  plannedKeys: readonly string[]
): readonly string[] {
  const plannedSet = new Set(plannedKeys);
  return baselineKeys.filter((candidateKey) => !plannedSet.has(candidateKey));
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((candidateKey, index) => candidateKey === right[index]);
}

function validationError(message: string): CoreError {
  return new CoreError("VALIDATION", message);
}
