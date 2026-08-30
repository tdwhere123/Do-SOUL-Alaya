import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  requireFiniteNumber,
  ShadowContractError
} from "../contract-primitives.js";

export const SHADOW_GAMMA_KINDS = [
  "unscaled_remainder",
  "Values_v",
  "evidence_novelty_redundancy"
] as const;

export type ShadowGammaKind = (typeof SHADOW_GAMMA_KINDS)[number];

export type ShadowFacilityKind =
  | "entity"
  | "relation"
  | "time"
  | "logical_object"
  | "independent_evidence";

export type ShadowObligationKey = Readonly<{
  readonly kind: ShadowFacilityKind;
  readonly value: string;
}>;

export type ShadowCoordinateAvailability =
  | "available"
  | "known_zero"
  | "unavailable"
  | "not_observed"
  | "not_applicable";

export type ShadowFacilityAvailability =
  | "not_applicable"
  | "available"
  | "partially_unavailable"
  | "unavailable";

export type ShadowOsfStatus =
  | "composed"
  | "no_match"
  | "truncated"
  | "rejected"
  | "ineligible"
  | "unavailable";

export type ShadowEvidenceIdentityAvailability = "available" | "unavailable";

export type ShadowWitnessStanding =
  | "available_positive"
  | "available_known_absent"
  | "unavailable"
  | "not_observed";

export type ShadowGammaTuple = Readonly<{
  readonly unscaled_remainder: number;
  readonly Values_v: number;
  readonly evidence_novelty_redundancy: 0 | 1;
}>;

export type ShadowGStatus = Readonly<{
  readonly facility: ShadowFacilityAvailability;
  readonly values: ShadowOsfStatus;
  readonly evidence_identity: ShadowEvidenceIdentityAvailability;
}>;

export type ShadowFacilityMatch = Readonly<{
  readonly obligation: ShadowObligationKey;
  readonly raw_atom_id: string;
  readonly attribution_kind: "typed_query_atom" | "typed_fact_frame";
  readonly match_strength: number;
}>;

export type ShadowFacilityObligationReceipt = Readonly<{
  readonly key: ShadowObligationKey;
  readonly raw_atom_ids: readonly string[];
  readonly availability: ShadowCoordinateAvailability;
  readonly cover: number;
  readonly evaluated: boolean;
}>;

export type ShadowValuePair = Readonly<{
  readonly variable_id: string;
  readonly semantic_identity: string;
}>;

export type ShadowValuesReceipt = Readonly<{
  readonly status: ShadowOsfStatus;
  readonly values: readonly ShadowValuePair[];
}>;

export type ShadowCidReceipt =
  | Readonly<{
      readonly status: "available";
      readonly cid: string;
      readonly grounding: "content" | "gist" | "ref";
    }>
  | Readonly<{
      readonly status: "unavailable";
    }>;

export type ShadowSetUtilityInput = Readonly<{
  readonly schema_version: 1;
  readonly candidate_key: string;
  readonly object_key: string;
  readonly obligations: readonly ShadowFacilityObligationReceipt[];
  readonly matches: readonly ShadowFacilityMatch[];
  readonly values: ShadowValuesReceipt;
  readonly cid: ShadowCidReceipt;
  readonly availability: ShadowGStatus;
}>;

const FACILITY_KINDS: ReadonlySet<string> = new Set([
  "entity",
  "relation",
  "time",
  "logical_object",
  "independent_evidence"
]);

const COORDINATE_AVAILABILITY: ReadonlySet<string> = new Set([
  "available",
  "known_zero",
  "unavailable",
  "not_observed",
  "not_applicable"
]);

const OSF_STATUSES: ReadonlySet<string> = new Set([
  "composed",
  "no_match",
  "truncated",
  "rejected",
  "ineligible",
  "unavailable"
]);

export function obligationIdentity(key: ShadowObligationKey): string {
  return `${key.kind}\u0000${key.value}`;
}

export function parseSetUtilityInput(input: unknown): ShadowSetUtilityInput {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("set-utility input must be an object");
  }
  rejectFrontierPriority(input);
  assertAllowedKeys(input, [
    "schema_version", "candidate_key", "object_key", "obligations",
    "matches", "values", "cid", "availability"
  ]);
  if (input.schema_version !== 1 ||
      typeof input.candidate_key !== "string" || input.candidate_key.length === 0 ||
      typeof input.object_key !== "string" || input.object_key.length === 0) {
    throw new ShadowContractError("invalid set-utility identity");
  }
  if (!Array.isArray(input.obligations) || !Array.isArray(input.matches)) {
    throw new ShadowContractError("set-utility obligations and matches must be arrays");
  }
  const obligations = Object.freeze(input.obligations.map(parseFacilityObligation));
  assertUniqueObligationKeys(obligations);
  const matches = Object.freeze(input.matches.map(parseFacilityMatch));
  const values = parseValuesReceipt(input.values);
  const cid = parseCidReceipt(input.cid, input.candidate_key, input.object_key);
  const availability = parseGStatus(input.availability, obligations, values, cid);
  return freezeShadow({
    schema_version: 1 as const,
    candidate_key: input.candidate_key,
    object_key: input.object_key,
    obligations,
    matches,
    values,
    cid,
    availability
  });
}

export function lowerFrontierNoveltyAdmission(params: Readonly<{
  readonly candidate_standing: ShadowWitnessStanding;
  readonly core_standings: readonly ShadowWitnessStanding[];
}>): "admitted" | "blocked" {
  if (params.candidate_standing !== "available_positive") return "blocked";
  if (params.core_standings.length === 0) return "blocked";
  return params.core_standings.every((standing) => standing === "available_known_absent")
    ? "admitted"
    : "blocked";
}

function parseFacilityObligation(input: unknown): ShadowFacilityObligationReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("facility obligation must be an object");
  }
  assertAllowedKeys(input, ["key", "raw_atom_ids", "availability", "cover", "evaluated"]);
  const key = parseObligationKey(input.key);
  if (!Array.isArray(input.raw_atom_ids) ||
      input.raw_atom_ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new ShadowContractError("obligation raw_atom_ids are provenance");
  }
  const cover = requireFiniteNumber(input.cover, "cover");
  if (typeof input.availability !== "string" ||
      !COORDINATE_AVAILABILITY.has(input.availability) ||
      typeof input.evaluated !== "boolean" ||
      cover < 0 || cover > 1) {
    throw new ShadowContractError("invalid facility obligation");
  }
  assertKnownZero(input.availability, input.evaluated, cover);
  return freezeShadow({
    key,
    raw_atom_ids: Object.freeze([...input.raw_atom_ids]),
    availability: input.availability as ShadowCoordinateAvailability,
    cover,
    evaluated: input.evaluated
  });
}

function parseFacilityMatch(input: unknown): ShadowFacilityMatch {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("facility match must be an object");
  }
  assertAllowedKeys(input, [
    "obligation", "raw_atom_id", "attribution_kind", "match_strength"
  ]);
  const matchStrength = requireFiniteNumber(input.match_strength, "match_strength");
  if (typeof input.raw_atom_id !== "string" || input.raw_atom_id.length === 0 ||
      (input.attribution_kind !== "typed_query_atom" &&
        input.attribution_kind !== "typed_fact_frame") ||
      matchStrength < 0 || matchStrength > 1) {
    throw new ShadowContractError("invalid facility match");
  }
  return freezeShadow({
    obligation: parseObligationKey(input.obligation),
    raw_atom_id: input.raw_atom_id,
    attribution_kind: input.attribution_kind,
    match_strength: matchStrength
  });
}

function parseObligationKey(input: unknown): ShadowObligationKey {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("obligation key must be an object");
  }
  assertAllowedKeys(input, ["kind", "value"]);
  if (typeof input.kind !== "string" || !FACILITY_KINDS.has(input.kind) ||
      typeof input.value !== "string" || input.value.length === 0) {
    throw new ShadowContractError("invalid obligation key");
  }
  return freezeShadow({
    kind: input.kind as ShadowFacilityKind,
    value: input.value
  });
}

function parseValuesReceipt(input: unknown): ShadowValuesReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("values receipt must be an object");
  }
  assertAllowedKeys(input, ["status", "values"]);
  if (typeof input.status !== "string" || !OSF_STATUSES.has(input.status) ||
      !Array.isArray(input.values)) {
    throw new ShadowContractError("invalid values receipt");
  }
  const values = Object.freeze(input.values.map(parseValuePair));
  if (input.status === "composed" && values.length === 0) {
    throw new ShadowContractError("composed empty values needs a completeness witness");
  }
  if (input.status !== "composed" && values.length > 0) {
    throw new ShadowContractError("non-composed values cannot carry a set");
  }
  return freezeShadow({
    status: input.status as ShadowOsfStatus,
    values
  });
}

function parseValuePair(input: unknown): ShadowValuePair {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("value pair must be an object");
  }
  assertAllowedKeys(input, ["variable_id", "semantic_identity"]);
  if (typeof input.variable_id !== "string" || input.variable_id.length === 0 ||
      typeof input.semantic_identity !== "string" || input.semantic_identity.length === 0) {
    throw new ShadowContractError("invalid value pair");
  }
  return freezeShadow({
    variable_id: input.variable_id,
    semantic_identity: input.semantic_identity
  });
}

function parseCidReceipt(
  input: unknown,
  candidateKey: string,
  objectKey: string
): ShadowCidReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("CID receipt must be an object");
  }
  if (input.status === "unavailable") {
    assertAllowedKeys(input, ["status"]);
    return freezeShadow({ status: "unavailable" });
  }
  if (input.status !== "available") {
    throw new ShadowContractError("CID status must be available or unavailable");
  }
  assertAllowedKeys(input, ["status", "cid", "grounding"]);
  if (typeof input.cid !== "string" ||
      (input.grounding !== "content" && input.grounding !== "gist" &&
        input.grounding !== "ref")) {
    throw new ShadowContractError("invalid available CID");
  }
  if (input.cid === candidateKey || input.cid === objectKey) {
    throw new ShadowContractError("CID cannot fall back to candidate or object key");
  }
  if (!input.cid.startsWith(`${input.grounding}:`)) {
    throw new ShadowContractError("CID grounding prefix mismatch");
  }
  return freezeShadow({
    status: "available",
    cid: input.cid,
    grounding: input.grounding
  });
}

function parseGStatus(
  input: unknown,
  obligations: readonly ShadowFacilityObligationReceipt[],
  values: ShadowValuesReceipt,
  cid: ShadowCidReceipt
): ShadowGStatus {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("G_status must be an object");
  }
  assertAllowedKeys(input, ["facility", "values", "evidence_identity"]);
  const facility = parseFacilityAvailability(input.facility, obligations);
  if (input.values !== values.status) {
    throw new ShadowContractError("G_status values must match OSF status");
  }
  if (input.evidence_identity !== cid.status) {
    throw new ShadowContractError("G_status evidence_identity must match CID");
  }
  return freezeShadow({
    facility,
    values: values.status,
    evidence_identity: cid.status
  });
}

function parseFacilityAvailability(
  value: unknown,
  obligations: readonly ShadowFacilityObligationReceipt[]
): ShadowFacilityAvailability {
  if (value !== "not_applicable" && value !== "available" &&
      value !== "partially_unavailable" && value !== "unavailable") {
    throw new ShadowContractError("invalid facility G_status");
  }
  if (obligations.length === 0 && value !== "not_applicable") {
    throw new ShadowContractError("empty facility demand drops the term");
  }
  return value;
}

function assertUniqueObligationKeys(
  obligations: readonly ShadowFacilityObligationReceipt[]
): void {
  const seen = new Set<string>();
  for (const obligation of obligations) {
    const id = obligationIdentity(obligation.key);
    if (seen.has(id)) {
      throw new ShadowContractError("correlated obligation aliases must collapse to one key");
    }
    seen.add(id);
  }
}

function assertKnownZero(
  availability: string,
  evaluated: boolean,
  cover: number
): void {
  if (availability === "known_zero" && (!evaluated || cover !== 0)) {
    throw new ShadowContractError("known-zero requires evaluated cover 0");
  }
  if ((availability === "unavailable" || availability === "not_observed") &&
      evaluated && cover > 0) {
    throw new ShadowContractError("unavailable coordinate cannot claim positive cover");
  }
}

function rejectFrontierPriority(input: Record<string, unknown>): void {
  if ("FrontierPriority" in input || "frontier_priority" in input) {
    throw new ShadowContractError("FrontierPriority is not a Gamma field");
  }
}
