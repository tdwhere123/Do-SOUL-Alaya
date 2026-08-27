import {
  SHADOW_PAIR_REASONS,
  type ShadowPairReason
} from "./compare.js";
import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  requireFiniteNumber,
  requireInteger,
  requireStringList,
  ShadowContractError
} from "./envelope.js";
import {
  SHADOW_DETERMINISTIC_TAIL,
  SHADOW_PSI_OPERATOR_ID
} from "./identity.js";
import type {
  ShadowGammaTuple,
  ShadowGStatus
} from "./capture.js";

export const SHADOW_DELIVERY_ORDER_FIELDS = [
  "selection_order",
  "ordering_basis",
  "selected_candidate_keys",
  "selected_rank",
  "FrontierPriority",
  "frontier_priority"
] as const;

export type ShadowHasDeliveryOrderField<T> = Extract<
  keyof T,
  (typeof SHADOW_DELIVERY_ORDER_FIELDS)[number]
>;

export type AssertShadowHasNoDeliveryOrder<T> =
  ShadowHasDeliveryOrderField<T> extends never ? T : never;

export type ShadowPsiEdge = Readonly<{
  readonly kind: "psi_edge";
  readonly operator_id: typeof SHADOW_PSI_OPERATOR_ID;
  readonly dominator: string;
  readonly dominated: string;
}>;

export type ShadowPsiPairReceipt = Readonly<{
  readonly left: string;
  readonly right: string;
  readonly reason: ShadowPairReason;
  readonly dominates: boolean;
}>;

export type ShadowPsiCycleFailure = Readonly<{
  readonly kind: "psi_cycle_contract_failure";
}>;

export type ShadowNotADominanceCompare = Readonly<{
  readonly kind: "not_a_dominance_compare";
  readonly reason: "h_ineligible";
  readonly gate: "event" | "temporal" | "hidden";
  readonly candidate_key: string;
}>;

export type ShadowEqualGReject = Readonly<{
  readonly candidate_key: string;
  readonly dominated_by: string;
}>;

export type ShadowCoreKnownNoWitness = Readonly<{
  readonly witness: "facility" | "values" | "evidence_identity";
  readonly core_candidate_key: string;
  readonly status: "available_known_absent";
  readonly basis: string;
}>;

export type ShadowCaptureReason = "core_undominated" | "cross_frontier_novelty";

export type ShadowDeterministicTailReason = typeof SHADOW_DETERMINISTIC_TAIL;

export type ShadowNamedNovelty = Readonly<{
  readonly facility_keys: readonly string[];
  readonly value_pairs: readonly string[];
  readonly content_ids: readonly string[];
}>;

export type ShadowCaptureDecisionReceipt = Readonly<{
  readonly schema_version: 1;
  readonly candidate_key: string;
  readonly capture_reason: ShadowCaptureReason;
  readonly G: ShadowGammaTuple;
  readonly G_status: ShadowGStatus;
  readonly named_novelty: ShadowNamedNovelty;
  readonly novelty_core_known_absence: readonly ShadowCoreKnownNoWitness[];
  readonly max_g_cohort: readonly string[];
  readonly equal_g_dominance_rejects: readonly ShadowEqualGReject[];
  readonly deterministic_tail: ShadowDeterministicTailReason;
  readonly unresolved_pointwise_tradeoff: boolean;
  readonly h_gate: "none" | "event" | "temporal" | "hidden";
  readonly walk_reject: "none" | "duplicate_object" | "dimension_limit" | "max_total_tokens";
  readonly static_frontier_index: number | null;
}>;

export type ShadowAdmitKind =
  | "fts.admit.v1"
  | "embed.admit.v1"
  | "temporal.admit.v1"
  | "graph.admit.v1"
  | "path.admit.v1";

export type ShadowEmbeddingAdmissionProvenance = Readonly<{
  readonly receipt: "embed.admit.v1";
  readonly membership_only: true;
  readonly cannot_evict_e0: true;
}>;

export type ShadowFieldMembership = Readonly<{
  readonly candidate_key: string;
  readonly e0_member: boolean;
  readonly e1_member: boolean;
  readonly admits: readonly ShadowAdmitKind[];
  readonly embedding_admission: ShadowEmbeddingAdmissionProvenance | null;
}>;

export type ShadowUnsupportedRelationalSource =
  | "path"
  | "flood"
  | "graph"
  | "edge"
  | "path_status"
  | "flood_trace"
  | "no_path_under_cap"
  | "truncation"
  | "cap_exhaustion"
  | "not_observed"
  | "producer_unavailable";

export type ShadowUnsupportedRelationalDiagnostic = Readonly<{
  readonly kind: "unsupported_relational_diagnostic";
  readonly source: ShadowUnsupportedRelationalSource;
  readonly facts: Readonly<Record<string, unknown>>;
}>;

const PAIR_REASON_SET: ReadonlySet<string> = new Set(SHADOW_PAIR_REASONS);
const ADMIT_KINDS: ReadonlySet<string> = new Set([
  "fts.admit.v1",
  "embed.admit.v1",
  "temporal.admit.v1",
  "graph.admit.v1",
  "path.admit.v1"
]);
const RELATIONAL_SOURCES: ReadonlySet<string> = new Set([
  "path",
  "flood",
  "graph",
  "edge",
  "path_status",
  "flood_trace",
  "no_path_under_cap",
  "truncation",
  "cap_exhaustion",
  "not_observed",
  "producer_unavailable"
]);

export function assertShadowReceiptHasNoDeliveryOrder(receipt: object): void {
  for (const field of SHADOW_DELIVERY_ORDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(receipt, field)) {
      throw new ShadowContractError(
        `shadow receipt must not carry delivery-order field ${field}`
      );
    }
  }
}

export function parsePsiEdge(input: unknown): ShadowPsiEdge {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("psi edge must be an object");
  }
  assertShadowReceiptHasNoDeliveryOrder(input);
  assertAllowedKeys(input, ["kind", "operator_id", "dominator", "dominated"]);
  if (input.kind !== "psi_edge" || input.operator_id !== SHADOW_PSI_OPERATOR_ID ||
      typeof input.dominator !== "string" || typeof input.dominated !== "string" ||
      input.dominator.length === 0 || input.dominated.length === 0) {
    throw new ShadowContractError("invalid psi edge");
  }
  if (input.dominator === input.dominated) {
    throw new ShadowContractError("psi edge is irreflexive");
  }
  return freezeShadow({
    kind: "psi_edge",
    operator_id: SHADOW_PSI_OPERATOR_ID,
    dominator: input.dominator,
    dominated: input.dominated
  });
}

export function parsePsiPairReceipt(input: unknown): ShadowPsiPairReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("psi pair receipt must be an object");
  }
  assertAllowedKeys(input, ["left", "right", "reason", "dominates"]);
  if (typeof input.left !== "string" || typeof input.right !== "string" ||
      typeof input.reason !== "string" || !PAIR_REASON_SET.has(input.reason) ||
      input.dominates !== false) {
    throw new ShadowContractError("invalid psi pair receipt");
  }
  return freezeShadow({
    left: input.left,
    right: input.right,
    reason: input.reason as ShadowPairReason,
    dominates: false
  });
}

export function parseEqualGReject(input: unknown): ShadowEqualGReject {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("equal-G reject must be an object");
  }
  assertAllowedKeys(input, ["candidate_key", "dominated_by"]);
  if (typeof input.candidate_key !== "string" || input.candidate_key.length === 0 ||
      typeof input.dominated_by !== "string" || input.dominated_by.length === 0 ||
      input.candidate_key === input.dominated_by) {
    throw new ShadowContractError("invalid equal-G reject");
  }
  return freezeShadow({
    candidate_key: input.candidate_key,
    dominated_by: input.dominated_by
  });
}

export function parseCoreKnownNoWitness(input: unknown): ShadowCoreKnownNoWitness {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("core known-no-witness must be an object");
  }
  assertAllowedKeys(input, ["witness", "core_candidate_key", "status", "basis"]);
  if ((input.witness !== "facility" && input.witness !== "values" &&
      input.witness !== "evidence_identity") ||
      typeof input.core_candidate_key !== "string" ||
      input.core_candidate_key.length === 0 ||
      typeof input.basis !== "string" || input.basis.length === 0) {
    throw new ShadowContractError("invalid core known-no-witness");
  }
  if (input.status !== "available_known_absent") {
    throw new ShadowContractError(
      "unavailable or not_observed Core cannot prove exclusivity"
    );
  }
  return freezeShadow({
    witness: input.witness,
    core_candidate_key: input.core_candidate_key,
    status: "available_known_absent",
    basis: input.basis
  });
}

export function parseCaptureDecisionReceipt(
  input: unknown
): ShadowCaptureDecisionReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("capture decision must be an object");
  }
  assertShadowReceiptHasNoDeliveryOrder(input);
  assertAllowedKeys(input, [
    "schema_version", "candidate_key", "capture_reason", "G", "G_status",
    "named_novelty", "novelty_core_known_absence", "max_g_cohort",
    "equal_g_dominance_rejects", "deterministic_tail",
    "unresolved_pointwise_tradeoff", "h_gate", "walk_reject",
    "static_frontier_index"
  ]);
  return freezeCaptureDecision(input);
}

export function parseFieldMembership(input: unknown): ShadowFieldMembership {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("field membership must be an object");
  }
  assertAllowedKeys(input, [
    "candidate_key", "e0_member", "e1_member", "admits", "embedding_admission"
  ]);
  if (typeof input.candidate_key !== "string" || input.candidate_key.length === 0 ||
      typeof input.e0_member !== "boolean" || typeof input.e1_member !== "boolean" ||
      !Array.isArray(input.admits)) {
    throw new ShadowContractError("invalid field membership");
  }
  if (input.e0_member && !input.e1_member) {
    throw new ShadowContractError("H_E0 must be a subset of H_E1");
  }
  const admits = Object.freeze(input.admits.map(parseAdmitKind));
  const embeddingAdmission = parseEmbeddingAdmission(
    input.embedding_admission,
    admits,
    input.e1_member
  );
  return freezeShadow({
    candidate_key: input.candidate_key,
    e0_member: input.e0_member,
    e1_member: input.e1_member,
    admits,
    embedding_admission: embeddingAdmission
  });
}

export function parseUnsupportedRelationalDiagnostic(
  input: unknown
): ShadowUnsupportedRelationalDiagnostic {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("unsupported diagnostic must be an object");
  }
  assertAllowedKeys(input, ["kind", "source", "facts"]);
  if (input.kind !== "unsupported_relational_diagnostic" ||
      typeof input.source !== "string" || !RELATIONAL_SOURCES.has(input.source) ||
      !isShadowRecord(input.facts)) {
    throw new ShadowContractError("invalid unsupported relational diagnostic");
  }
  return freezeShadow({
    kind: "unsupported_relational_diagnostic",
    source: input.source as ShadowUnsupportedRelationalSource,
    facts: freezeShadow({ ...input.facts })
  });
}

export function observationFromUnsupportedDiagnostic(
  _diagnostic: ShadowUnsupportedRelationalDiagnostic
): never {
  throw new ShadowContractError("Path/Flood facts cannot instantiate v1 observation");
}

export function rejectNegativeRelationalEvidence(
  diagnostic: ShadowUnsupportedRelationalDiagnostic
): never {
  throw new ShadowContractError(
    `${diagnostic.source} cannot validate as negative relational evidence`
  );
}

function parseAdmitKind(value: unknown): ShadowAdmitKind {
  if (typeof value !== "string" || !ADMIT_KINDS.has(value)) {
    throw new ShadowContractError("invalid membership admit receipt");
  }
  return value as ShadowAdmitKind;
}

function parseEmbeddingAdmission(
  input: unknown,
  admits: readonly ShadowAdmitKind[],
  e1Member: boolean
): ShadowEmbeddingAdmissionProvenance | null {
  if (input === null) {
    if (admits.includes("embed.admit.v1")) {
      throw new ShadowContractError("embed.admit.v1 needs provenance");
    }
    return null;
  }
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("embedding admission must be an object");
  }
  assertAllowedKeys(input, ["receipt", "membership_only", "cannot_evict_e0"]);
  if (input.receipt !== "embed.admit.v1" || input.membership_only !== true ||
      input.cannot_evict_e0 !== true || !e1Member ||
      !admits.includes("embed.admit.v1")) {
    throw new ShadowContractError("invalid embedding-admission provenance");
  }
  return freezeShadow({
    receipt: "embed.admit.v1",
    membership_only: true,
    cannot_evict_e0: true
  });
}

function freezeCaptureDecision(
  input: Record<string, unknown>
): ShadowCaptureDecisionReceipt {
  if (input.schema_version !== 1 ||
      typeof input.candidate_key !== "string" || input.candidate_key.length === 0 ||
      (input.capture_reason !== "core_undominated" &&
        input.capture_reason !== "cross_frontier_novelty") ||
      input.deterministic_tail !== SHADOW_DETERMINISTIC_TAIL ||
      typeof input.unresolved_pointwise_tradeoff !== "boolean") {
    throw new ShadowContractError("invalid capture decision identity");
  }
  if (!Array.isArray(input.max_g_cohort) ||
      !Array.isArray(input.equal_g_dominance_rejects) ||
      !Array.isArray(input.novelty_core_known_absence)) {
    throw new ShadowContractError("invalid capture cohorts");
  }
  const rejects = Object.freeze(input.equal_g_dominance_rejects.map(parseEqualGReject));
  const absence = Object.freeze(input.novelty_core_known_absence.map(parseCoreKnownNoWitness));
  return freezeShadow({
    schema_version: 1 as const,
    candidate_key: input.candidate_key,
    capture_reason: input.capture_reason,
    G: parseGammaTuple(input.G),
    G_status: parseDecisionGStatus(input.G_status),
    named_novelty: parseNamedNovelty(input.named_novelty, input.capture_reason),
    novelty_core_known_absence: absence,
    max_g_cohort: Object.freeze(requireStringList(input.max_g_cohort, "max_g_cohort")),
    equal_g_dominance_rejects: rejects,
    deterministic_tail: SHADOW_DETERMINISTIC_TAIL,
    unresolved_pointwise_tradeoff: input.unresolved_pointwise_tradeoff,
    h_gate: parseHGate(input.h_gate),
    walk_reject: parseWalkReject(input.walk_reject),
    static_frontier_index: parseFrontierIndex(input.static_frontier_index)
  });
}

function parseGammaTuple(input: unknown): ShadowGammaTuple {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("G must be an object");
  }
  if ("FrontierPriority" in input || "frontier_priority" in input) {
    throw new ShadowContractError("FrontierPriority is not a Gamma field");
  }
  assertAllowedKeys(input, [
    "unscaled_remainder", "Values_v", "evidence_novelty_redundancy"
  ]);
  const remainder = requireFiniteNumber(input.unscaled_remainder, "unscaled_remainder");
  const values = requireInteger(input.Values_v, "Values_v");
  if (remainder < 0 || values < 0 ||
      (input.evidence_novelty_redundancy !== 0 &&
        input.evidence_novelty_redundancy !== 1)) {
    throw new ShadowContractError("invalid Gamma tuple");
  }
  return freezeShadow({
    unscaled_remainder: remainder,
    Values_v: values,
    evidence_novelty_redundancy: input.evidence_novelty_redundancy
  });
}

function parseDecisionGStatus(input: unknown): ShadowGStatus {
  const record = isShadowRecord(input) ? input : null;
  if (record === null) throw new ShadowContractError("G_status must be an object");
  assertAllowedKeys(record, ["facility", "values", "evidence_identity"]);
  const facility = record.facility;
  const values = record.values;
  const evidence = record.evidence_identity;
  if ((facility !== "not_applicable" && facility !== "available" &&
      facility !== "partially_unavailable" && facility !== "unavailable") ||
      (values !== "composed" && values !== "no_match" && values !== "truncated" &&
        values !== "rejected" && values !== "ineligible" && values !== "unavailable") ||
      (evidence !== "available" && evidence !== "unavailable")) {
    throw new ShadowContractError("invalid decision G_status");
  }
  return freezeShadow({ facility, values, evidence_identity: evidence });
}

function parseNamedNovelty(
  input: unknown,
  reason: unknown
): ShadowNamedNovelty {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("named_novelty must be an object");
  }
  assertAllowedKeys(input, ["facility_keys", "value_pairs", "content_ids"]);
  const novelty = freezeShadow({
    facility_keys: Object.freeze(requireStringList(input.facility_keys, "facility_keys")),
    value_pairs: Object.freeze(requireStringList(input.value_pairs, "value_pairs")),
    content_ids: Object.freeze(requireStringList(input.content_ids, "content_ids"))
  });
  const named = novelty.facility_keys.length + novelty.value_pairs.length +
    novelty.content_ids.length;
  if (reason === "cross_frontier_novelty" && named === 0) {
    throw new ShadowContractError("cross-frontier capture must name novelty");
  }
  if (reason === "core_undominated" && named !== 0) {
    throw new ShadowContractError("core capture must not name novelty");
  }
  return novelty;
}

function parseHGate(value: unknown): ShadowCaptureDecisionReceipt["h_gate"] {
  if (value === "none" || value === "event" || value === "temporal" || value === "hidden") {
    return value;
  }
  throw new ShadowContractError("invalid h_gate");
}

function parseWalkReject(value: unknown): ShadowCaptureDecisionReceipt["walk_reject"] {
  if (value === "none" || value === "duplicate_object" ||
      value === "dimension_limit" || value === "max_total_tokens") return value;
  throw new ShadowContractError("invalid walk_reject");
}

function parseFrontierIndex(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ShadowContractError("static_frontier_index is structure only");
  }
  return value as number;
}

