import {
  assertAllowedKeys,
  assertShadowReceiptHasNoDeliveryOrder,
  freezeShadow,
  isShadowRecord,
  requireFiniteNumber,
  requireInteger,
  requireStringList,
  ShadowContractError
} from "../contract-primitives.js";
import { SHADOW_DETERMINISTIC_TAIL } from "./identity.js";
import type {
  ShadowGammaTuple,
  ShadowGStatus
} from "./capture.js";

export const COMPILED_GAMMA_KEYS = [
  "answer_binding_position",
  "required_proposition_support",
  "certified_independent_support"
] as const;

export type QueryCompiledWalkGamma = Readonly<{
  readonly answer_binding_position: number;
  readonly required_proposition_support: number;
  readonly certified_independent_support: number;
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
  readonly compiled_atom_ids?: readonly string[];
}>;

export type ShadowCaptureDecisionReceipt = Readonly<{
  readonly schema_version: 1;
  readonly candidate_key: string;
  readonly capture_reason: ShadowCaptureReason;
  readonly G: ShadowGammaTuple | QueryCompiledWalkGamma;
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

function parseGammaTuple(input: unknown): ShadowGammaTuple | QueryCompiledWalkGamma {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("G must be an object");
  }
  if ("FrontierPriority" in input || "frontier_priority" in input) {
    throw new ShadowContractError("FrontierPriority is not a Gamma field");
  }
  if (COMPILED_GAMMA_KEYS.every((key) => key in input)) {
    return parseCompiledGammaTuple(input);
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

function parseCompiledGammaTuple(input: Record<string, unknown>): QueryCompiledWalkGamma {
  if ("unscaled_remainder" in input || "Values_v" in input ||
      "evidence_novelty_redundancy" in input) {
    throw new ShadowContractError("compiled Gamma cannot mix live facility fields");
  }
  assertAllowedKeys(input, [...COMPILED_GAMMA_KEYS]);
  const tuple = freezeShadow({
    answer_binding_position: requireInteger(input.answer_binding_position,
      "answer_binding_position"),
    required_proposition_support: requireInteger(input.required_proposition_support,
      "required_proposition_support"),
    certified_independent_support: requireInteger(input.certified_independent_support,
      "certified_independent_support")
  });
  if (COMPILED_GAMMA_KEYS.some((key) => tuple[key] < 0)) {
    throw new ShadowContractError("invalid compiled Gamma tuple");
  }
  return tuple;
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
  assertAllowedKeys(input, [
    "facility_keys", "value_pairs", "content_ids", "compiled_atom_ids"
  ]);
  const compiled = input.compiled_atom_ids === undefined
    ? undefined
    : Object.freeze(requireStringList(input.compiled_atom_ids, "compiled_atom_ids"));
  const novelty = freezeShadow({
    facility_keys: Object.freeze(requireStringList(input.facility_keys, "facility_keys")),
    value_pairs: Object.freeze(requireStringList(input.value_pairs, "value_pairs")),
    content_ids: Object.freeze(requireStringList(input.content_ids, "content_ids")),
    ...(compiled === undefined ? {} : { compiled_atom_ids: compiled })
  });
  const liveNamed = novelty.facility_keys.length + novelty.value_pairs.length +
    novelty.content_ids.length;
  const compiledNamed = compiled?.length ?? 0;
  if (liveNamed > 0 && compiledNamed > 0) {
    throw new ShadowContractError("live novelty and compiled atoms cannot mix");
  }
  const named = liveNamed + compiledNamed;
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
