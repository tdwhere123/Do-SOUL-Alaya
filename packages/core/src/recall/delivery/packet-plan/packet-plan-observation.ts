import { CoreError } from "../../../shared/errors.js";

export const DIRECT_QUERY_EVIDENCE_STREAMS = Object.freeze([
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "entity_seed",
  "temporal_recency"
] as const);

export type DirectQueryEvidenceStream =
  (typeof DIRECT_QUERY_EVIDENCE_STREAMS)[number];

export type RecallPacketPlanDecision =
  | Readonly<{
      readonly status: "accepted";
      readonly reason:
        | "strict_tail_consensus"
        | "nested_membership_consensus";
    }>
  | Readonly<{
      readonly status: "no_op";
      readonly reason: "no_finite_embedding_head" | "unchanged_consensus";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly reason:
        | "admission_infeasible"
        | "coverage_order_retained"
        | "cardinality_mismatch"
        | "protected_candidate_constraint";
    }>;

type RecallPacketMembershipSlot = Readonly<{
  readonly slot: number;
  readonly candidate_key: string;
}>;

type RecallPacketMembershipAuthorizationBase = Readonly<{
  readonly authorized_candidate_key: string;
  readonly satisfied_by_candidate_key: string;
  readonly satisfied_head_slot: number;
  readonly displaced_head_baseline: RecallPacketMembershipSlot | null;
  readonly evicted_packet_baseline: RecallPacketMembershipSlot | null;
}>;

export type RecallPacketMembershipAuthorization =
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "direct_query_evidence";
      readonly witness: Readonly<{
        readonly origin:
          | "pre_projection_requirement"
          | "proposed_head"
          | "planned_tail_opportunity";
        readonly stream: DirectQueryEvidenceStream;
        readonly rank: number;
        readonly source_proximity_rank: number | null;
        readonly source_evidence_agreement_rank: number | null;
      }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "graph_path_opportunity";
      readonly witness: Readonly<{
        readonly graph_expansion_rank: number;
        readonly source_proximity_rank: number;
        readonly source_candidate_key: string;
        readonly target_candidate_key: string;
        readonly path_id: string;
        readonly path_source_version: string;
        readonly relation_kind: "answers_with";
      }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "behavior_identity";
      readonly witness: Readonly<{ readonly evidence_ref: string }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "selector_consensus";
      readonly witness: Readonly<{ readonly embedding_rank: number }>;
    }>
  | RecallPacketMembershipAuthorizationBase & Readonly<{
      readonly kind: "same_session_substitution";
      readonly witness: Readonly<{
        readonly protected_candidate_key: string;
        readonly substitute_candidate_key: string;
        readonly source_candidate_key: string;
        readonly target_candidate_key: string;
        readonly path_id: string;
        readonly path_source_version: string;
        readonly relation_kind: "answers_with";
        readonly session_key: string;
      }>;
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
  readonly embedding_rank_basis?:
    | "source_semantic_rrf"
    | "source_semantic_rrf_then_packet_relative";
  readonly source_semantic_intermediate_candidate_keys?: readonly string[];
  readonly packet_relative_embedding_head?: readonly Readonly<{
    readonly candidate_key: string;
    readonly embedding_rank: number;
  }>[];
  readonly tail_policy?: "head_tail_exchange" | "nested_membership_exchange";
  readonly membership_authorizations: readonly RecallPacketMembershipAuthorization[];
  readonly protected_candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly rank_limit: number;
  }>[];
  readonly decision: RecallPacketPlanDecision;
}>;

export function assertRecallPacketPlanObservation(
  observation: RecallPacketPlanObservation
): void {
  const baseline = observation.baseline_candidate_keys;
  const planned = observation.planned_candidate_keys;
  const actual = observation.actual_candidate_keys;
  const baselineHead = observation.baseline_head_candidate_keys;
  const consensusHead = observation.consensus_head_candidate_keys;
  const immutableTail = observation.immutable_tail_candidate_keys;
  const expectedHeadWidth = observation.tail_policy === "nested_membership_exchange"
    ? Math.min(5, baseline.length)
    : Math.ceil(baseline.length / 2);
  assertUniqueKeys(baseline, "baseline");
  assertUniqueKeys(planned, "planned");
  assertUniqueKeys(actual, "actual");
  if (
    observation.head_width !== expectedHeadWidth ||
    baselineHead.length !== observation.head_width ||
    (observation.decision.reason !== "cardinality_mismatch" &&
      consensusHead.length !== observation.head_width)
  ) {
    throw validationError("Packet plan head width is inconsistent");
  }
  if (!sameOrderedKeys(baselineHead, baseline.slice(0, observation.head_width))) {
    throw validationError("Packet plan baseline head is not a prefix");
  }
  if (
    observation.decision.reason !== "cardinality_mismatch" &&
    planned.length !== baseline.length
  ) {
    throw validationError("Packet plan cardinality is inconsistent");
  }
  if (
    observation.tail_policy === undefined &&
    !sameOrderedKeys(baseline, [...baselineHead, ...immutableTail])
  ) {
    throw validationError("Packet plan baseline partition is inconsistent");
  }
  if (!sameOrderedKeys(planned, [...consensusHead, ...immutableTail])) {
    throw validationError("Packet plan proposal is inconsistent");
  }
  assertEmbeddingHead(observation);
  assertEmbeddingRankBasis(observation);
  assertProtections(observation);
  assertMembershipAuthorizations(observation);
  assertTailPolicy(observation);
  assertDecisionReason(observation);
  assertDecision(observation, baseline, planned, actual);
}

function assertEmbeddingRankBasis(observation: RecallPacketPlanObservation): void {
  const sourceSemantic = observation.source_semantic_intermediate_candidate_keys;
  const packetRelative = observation.packet_relative_embedding_head;
  if (observation.embedding_rank_basis === undefined) {
    if (sourceSemantic !== undefined || packetRelative !== undefined) {
      throw validationError("Legacy packet plan carries composite rank evidence");
    }
    return;
  }
  if (observation.embedding_rank_basis === "source_semantic_rrf") {
    if (sourceSemantic !== undefined || packetRelative !== undefined) {
      throw validationError("Source semantic rank evidence carries an unexecuted phase");
    }
    return;
  }
  if (observation.embedding_rank_basis !== "source_semantic_rrf_then_packet_relative") {
    throw validationError("Packet plan embedding rank basis is invalid");
  }
  if (sourceSemantic === undefined || packetRelative === undefined ||
      sourceSemantic.length !== observation.baseline_candidate_keys.length ||
      !sameKeySet(sourceSemantic, observation.planned_candidate_keys)) {
    throw validationError("Composite packet rank evidence is incomplete");
  }
  assertUniqueKeys(sourceSemantic, "source semantic intermediate");
  assertUniqueKeys(
    packetRelative.map((entry) => entry.candidate_key),
    "packet relative embedding head"
  );
  if (packetRelative.some((entry) =>
    !Number.isInteger(entry.embedding_rank) || entry.embedding_rank <= 0 ||
    entry.embedding_rank > observation.head_width ||
    !sourceSemantic.includes(entry.candidate_key))) {
    throw validationError("Packet relative embedding head is invalid");
  }
}

function assertMembershipAuthorizations(
  observation: RecallPacketPlanObservation
): void {
  if (observation.tail_policy === "head_tail_exchange") return;
  const authorizations = observation.membership_authorizations;
  if (authorizations.length === 0 &&
      ["strict_tail_consensus", "admission_infeasible", "coverage_order_retained"].includes(
        observation.decision.reason
      )) return;
  const deliverable = observation.decision.status === "accepted" ||
    observation.decision.reason === "admission_infeasible" ||
    observation.decision.reason === "coverage_order_retained";
  if (!deliverable) {
    if (authorizations.length > 0) {
      throw validationError("Rejected packet proposal carries membership authorization");
    }
    return;
  }
  assertUniqueKeys(
    authorizations.map((item) => item.satisfied_by_candidate_key),
    "membership authorization candidates"
  );
  const protectedKeys = new Set(
    observation.protected_candidates.map((item) => item.candidate_key)
  );
  const introduced = observation.consensus_head_candidate_keys.filter(
    (key) => !observation.baseline_head_candidate_keys.includes(key) &&
      !protectedKeys.has(key)
  );
  if (!sameKeySet(
    introduced,
    authorizations.map((item) => item.satisfied_by_candidate_key)
  )) {
    throw validationError("Packet membership authorization candidates are inconsistent");
  }
  if (!retainedHeadOrderIsStable(observation)) {
    throw validationError("Packet membership retained order is inconsistent");
  }
  if (authorizations.some((item) => !authorizationIsBound(item, observation))) {
    throw validationError("Packet membership authorization binding is inconsistent");
  }
}

function retainedHeadOrderIsStable(
  observation: RecallPacketPlanObservation
): boolean {
  const retained = observation.consensus_head_candidate_keys.filter(
    (key) => observation.baseline_head_candidate_keys.includes(key)
  );
  const expected = observation.baseline_head_candidate_keys.filter(
    (key) => observation.consensus_head_candidate_keys.includes(key)
  );
  return sameOrderedKeys(retained, expected);
}

function authorizationIsBound(
  receipt: RecallPacketMembershipAuthorization,
  observation: RecallPacketPlanObservation
): boolean {
  const index = receipt.satisfied_head_slot - 1;
  if (!Number.isInteger(receipt.satisfied_head_slot) || index < 0 ||
      observation.consensus_head_candidate_keys[index] !==
        receipt.satisfied_by_candidate_key) return false;
  const displacedKey = observation.baseline_head_candidate_keys[index];
  const expectedDisplaced = displacedKey === undefined ||
    displacedKey === receipt.satisfied_by_candidate_key ? null : displacedKey;
  if (!slotMatches(receipt.displaced_head_baseline, expectedDisplaced, index)) return false;
  const addedAuthorizations = observation.membership_authorizations.filter(
    (item) => !observation.baseline_candidate_keys.includes(
      item.satisfied_by_candidate_key
    )
  );
  const addedIndex = addedAuthorizations.indexOf(receipt);
  const removed = observation.baseline_candidate_keys.filter(
    (key) => !observation.planned_candidate_keys.includes(key)
  );
  const expectedEvicted = addedIndex < 0 ? null : removed[addedIndex] ?? null;
  const evictedIndex = expectedEvicted === null ? -1 :
    observation.baseline_candidate_keys.indexOf(expectedEvicted);
  if (!slotMatches(receipt.evicted_packet_baseline, expectedEvicted, evictedIndex)) return false;
  return witnessIsBound(receipt, observation.head_width);
}

function witnessIsBound(
  receipt: RecallPacketMembershipAuthorization,
  headWidth: number
): boolean {
  if (receipt.kind === "direct_query_evidence") {
    return DIRECT_QUERY_EVIDENCE_STREAMS.includes(receipt.witness.stream) &&
      isBoundedPositiveRank(receipt.witness.rank, headWidth) &&
      isPositiveRankOrNull(receipt.witness.source_proximity_rank) &&
      isPositiveRankOrNull(receipt.witness.source_evidence_agreement_rank) &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "behavior_identity") {
    return receipt.witness.evidence_ref.trim().length > 0 &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "selector_consensus") {
    return isBoundedPositiveRank(receipt.witness.embedding_rank, headWidth) &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "graph_path_opportunity") {
    return receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key &&
      receipt.witness.target_candidate_key === receipt.satisfied_by_candidate_key &&
      isBoundedPositiveRank(receipt.witness.graph_expansion_rank, headWidth) &&
      isPositiveRankOrNull(receipt.witness.source_proximity_rank) &&
      nonEmptyPathWitness(receipt.witness);
  }
  return receipt.witness.protected_candidate_key === receipt.authorized_candidate_key &&
    receipt.witness.source_candidate_key === receipt.authorized_candidate_key &&
    receipt.witness.substitute_candidate_key === receipt.satisfied_by_candidate_key &&
    receipt.witness.target_candidate_key === receipt.satisfied_by_candidate_key &&
    receipt.witness.session_key.trim().length > 0 &&
    nonEmptyPathWitness(receipt.witness);
}

function isBoundedPositiveRank(value: number, upperBound: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= upperBound;
}

function isPositiveRankOrNull(value: number | null): boolean {
  return value === null || Number.isInteger(value) && value > 0;
}

function nonEmptyPathWitness(witness: Readonly<{
  readonly path_id: string;
  readonly path_source_version: string;
  readonly relation_kind: "answers_with";
}>): boolean {
  return witness.path_id.trim().length > 0 &&
    witness.path_source_version.trim().length > 0 &&
    witness.relation_kind === "answers_with";
}

function slotMatches(
  slot: RecallPacketMembershipSlot | null,
  expectedKey: string | null,
  expectedIndex: number
): boolean {
  return expectedKey === null
    ? slot === null
    : slot?.candidate_key === expectedKey && slot.slot === expectedIndex + 1;
}

function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((key) => right.includes(key));
}

function assertTailPolicy(observation: RecallPacketPlanObservation): void {
  const reason = observation.decision.reason;
  const requiresTailPolicy = reason === "nested_membership_consensus";
  const headTailExchange = observation.tail_policy === "head_tail_exchange";
  const permitsTailPolicy = requiresTailPolicy || headTailExchange ||
    reason === "admission_infeasible" || reason === "coverage_order_retained";
  if ((requiresTailPolicy && observation.tail_policy === undefined) ||
      (!permitsTailPolicy && observation.tail_policy !== undefined)) {
    throw validationError("Packet membership tail policy is inconsistent");
  }
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
    (entry) => !observation.baseline_candidate_keys.includes(entry.candidate_key) ||
      !Number.isInteger(entry.rank_limit) || entry.rank_limit <= 0
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
  if (reason === "unchanged_consensus" && (!hasEmbeddingHead || changed)) {
    throw validationError("Unchanged consensus decision is inconsistent");
  }
  if (
    ["strict_tail_consensus", "protected_candidate_constraint"].includes(reason) &&
    ((!hasEmbeddingHead && observation.protected_candidates.length === 0) ||
      !changed)
  ) {
    throw validationError("Changed consensus decision is inconsistent");
  }
  if (
    ["nested_membership_consensus", "admission_infeasible", "coverage_order_retained"].includes(reason) &&
    !changed
  ) {
    throw validationError("Changed membership decision is inconsistent");
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
    ["strict_tail_consensus", "nested_membership_consensus",
      "admission_infeasible", "coverage_order_retained"].includes(observation.decision.reason) &&
    !protectionsSatisfied
  ) {
    throw validationError("Accepted consensus violates a protected candidate");
  }
}

function assertUniqueKeys(keys: readonly string[], label: string): void {
  if (keys.some((key) => key.trim().length === 0) ||
      new Set(keys).size !== keys.length) {
    throw validationError(`Packet plan ${label} contains duplicate keys`);
  }
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((candidateKey, index) => candidateKey === right[index]);
}

function validationError(message: string): CoreError {
  return new CoreError("VALIDATION", message);
}
