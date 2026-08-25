import {
  assertAllowedKeys,
  freezeShadow,
  parseShadowEnvelope,
  requireFiniteNumber,
  requireInteger,
  requireNonemptyString,
  requireShadowRecord,
  requireStringList,
  ShadowContractError,
  type ShadowEnvelope
} from "./envelope.js";

export const SHADOW_LINEAGE_IDS = [
  "lexical", "embedding", "temporal", "subject_preference"
] as const;
export type ShadowLineageId = (typeof SHADOW_LINEAGE_IDS)[number];

export const LEX_LANE_IDS = [
  "exact", "porter", "trigram", "object_key_porter", "object_key_trigram"
] as const;
export type LexLaneId = (typeof LEX_LANE_IDS)[number];
export type LexListStatus = "empty" | "complete" | "truncated";
export type LexRawKeyKind = "matched_token_count" | "bm25_raw_rank";

export type LexDomain = Readonly<{
  readonly lane_id: LexLaneId;
  readonly list_n: number;
  readonly status: LexListStatus;
  readonly raw_key_kind: LexRawKeyKind;
}>;
export type EmbDomain = Readonly<{
  readonly provider_kind: string;
  readonly model_id: string;
  readonly dimensions: number;
  readonly schema_version: number;
}>;
export type ShadowTemporalDomain =
  | Readonly<{
      readonly kind: "window";
      readonly query_id: string;
      readonly start_ms: number;
      readonly end_ms: number;
      readonly decay_days: 90;
    }>
  | Readonly<{
      readonly kind: "recency";
      readonly query_id: string;
      readonly now_iso: string;
      readonly decay_days: 365;
    }>;
export type ShadowSubjectComponentId = "preference" | "self_reference";
export type SubjDomain = Readonly<{
  readonly query_id: string;
  readonly applicable_component_ids: readonly ShadowSubjectComponentId[];
  readonly component_operator_ids: readonly string[];
}>;
export type ShadowEmbeddingScoreSnapshot = Readonly<{
  readonly status: ShadowEnvelope["state"];
  readonly value: number | null;
  readonly domain: EmbDomain | null;
  readonly content_hash: string | null;
}>;
export type ShadowTemporalEvaluator = Readonly<{
  readonly applicable: boolean;
  readonly parse_state: "window" | "unparseable_date_terms" | "recency" | "not_applicable";
  readonly clock_state: "ok" | "unusable";
  readonly candidate_evaluated: boolean;
  readonly event_time: string | null;
  readonly domain: ShadowTemporalDomain | null;
  readonly finite_value: number | null;
}>;
export type ShadowSubjectComponent = Readonly<{
  readonly component_id: ShadowSubjectComponentId;
  readonly operator_id: string;
  readonly envelope: ShadowEnvelope;
}>;
export type ShadowLexicalObservation = Readonly<{
  readonly lineage: "lexical";
  readonly receipt: "fts.lexical.observe.v1";
  readonly correlation: "dup:lexical-family";
  readonly envelope: ShadowEnvelope;
  readonly domain: LexDomain | null;
}>;
export type ShadowEmbeddingObservation = Readonly<{
  readonly lineage: "embedding";
  readonly receipt: "embed.observe.v1";
  readonly correlation: "dup:embed-max-v1";
  readonly envelope: ShadowEnvelope;
  readonly snapshot: ShadowEmbeddingScoreSnapshot;
}>;
export type ShadowTemporalObservation = Readonly<{
  readonly lineage: "temporal";
  readonly receipt: "temporal.observe.v1";
  readonly correlation: "temporal.observe.v1";
  readonly envelope: ShadowEnvelope;
  readonly evaluator: ShadowTemporalEvaluator;
}>;
export type ShadowSubjectObservation = Readonly<{
  readonly lineage: "subject_preference";
  readonly receipt: "subject.observe.v1";
  readonly correlation: "subject.observe.v1";
  readonly envelope: ShadowEnvelope;
  readonly domain: SubjDomain;
  readonly components: readonly ShadowSubjectComponent[];
}>;
export type ShadowPointwiseObservation =
  | ShadowLexicalObservation
  | ShadowEmbeddingObservation
  | ShadowTemporalObservation
  | ShadowSubjectObservation;

const LEX_LANE_SET: ReadonlySet<string> = new Set(LEX_LANE_IDS);
const SUBJECT_COMPONENT_IDS: ReadonlySet<string> = new Set([
  "preference", "self_reference"
]);

export function lexDomainsEqual(left: LexDomain, right: LexDomain): boolean {
  return left.lane_id === right.lane_id && left.list_n === right.list_n &&
    left.status === right.status && left.raw_key_kind === right.raw_key_kind;
}

export function embeddingDomainsEqual(left: EmbDomain, right: EmbDomain): boolean {
  return left.provider_kind === right.provider_kind &&
    left.model_id === right.model_id && left.dimensions === right.dimensions &&
    left.schema_version === right.schema_version;
}

export function subjectDomainsEqual(left: SubjDomain, right: SubjDomain): boolean {
  return left.query_id === right.query_id &&
    sameStringList(left.applicable_component_ids, right.applicable_component_ids) &&
    sameStringList(left.component_operator_ids, right.component_operator_ids);
}

export function temporalDomainsEqual(
  left: ShadowTemporalDomain,
  right: ShadowTemporalDomain
): boolean {
  if (left.kind === "window" && right.kind === "window") {
    return left.query_id === right.query_id && left.start_ms === right.start_ms &&
      left.end_ms === right.end_ms && left.decay_days === right.decay_days;
  }
  return left.kind === "recency" && right.kind === "recency" &&
    left.query_id === right.query_id && left.now_iso === right.now_iso &&
    left.decay_days === right.decay_days;
}

export function parsePointwiseObservation(input: unknown): ShadowPointwiseObservation {
  const record = requireShadowRecord(input, "observation");
  if (record.lineage === "path" || record.lineage === "flood" ||
      record.lineage === "graph" || record.lineage === "relation") {
    throw new ShadowContractError("relational observation is not admitted");
  }
  if (record.lineage === "lexical") return parseLexicalObservation(record);
  if (record.lineage === "embedding") return parseEmbeddingObservation(record);
  if (record.lineage === "temporal") return parseTemporalObservation(record);
  if (record.lineage === "subject_preference") return parseSubjectObservation(record);
  throw new ShadowContractError("unknown observation lineage");
}

export function combineSubjectComponentEnvelopes(
  components: readonly ShadowSubjectComponent[]
): ShadowEnvelope {
  const illegal = components.find((component) =>
    component.envelope.state === "observed_negative" ||
    component.envelope.state === "required_but_missing");
  if (illegal !== undefined) return illegal.envelope;
  const applicable = components.filter((component) =>
    component.envelope.state !== "not_applicable");
  if (applicable.length === 0) return freezeShadow({ state: "not_applicable" });
  const missing = applicable.find((component) => component.envelope.state === "not_observed");
  if (missing !== undefined) return missing.envelope;
  const unavailable = applicable.find((component) =>
    component.envelope.state === "producer_unavailable");
  if (unavailable !== undefined) return unavailable.envelope;
  return freezeShadow({
    state: "observed",
    value: Math.max(...applicable.map(observedValue))
  });
}

export function parseLexDomain(input: unknown): LexDomain {
  const record = requireShadowRecord(input, "LexDomain");
  assertAllowedKeys(record, ["lane_id", "list_n", "status", "raw_key_kind"]);
  if (typeof record.lane_id !== "string" || !LEX_LANE_SET.has(record.lane_id)) {
    throw new ShadowContractError("invalid lexical lane_id");
  }
  const listN = requireInteger(record.list_n, "list_n");
  if (listN < 0) {
    throw new ShadowContractError("list_n must be a natural number");
  }
  const rawKey = record.lane_id === "exact" ? "matched_token_count" : "bm25_raw_rank";
  if (record.raw_key_kind !== rawKey) {
    throw new ShadowContractError("raw_key_kind does not match lane_id");
  }
  return freezeShadow({
    lane_id: record.lane_id as LexLaneId,
    list_n: listN,
    status: parseLexStatus(record.status, listN),
    raw_key_kind: rawKey
  });
}

function parseLexicalObservation(input: Record<string, unknown>): ShadowLexicalObservation {
  assertReceipt(input, "fts.lexical.observe.v1", "dup:lexical-family", ["domain"]);
  const envelope = parseMagnitudeEnvelope(input, "lexical");
  const domain = input.domain === null ? null : parseLexDomain(input.domain);
  if (envelope.state === "observed" &&
      (domain === null || domain.status === "empty" || envelope.value <= 0)) {
    throw new ShadowContractError("empty or missing LexDomain cannot be observed");
  }
  return freezeShadow({
    lineage: "lexical",
    receipt: "fts.lexical.observe.v1",
    correlation: "dup:lexical-family",
    envelope,
    domain
  });
}

function parseEmbeddingObservation(input: Record<string, unknown>): ShadowEmbeddingObservation {
  assertReceipt(input, "embed.observe.v1", "dup:embed-max-v1", ["snapshot"]);
  const envelope = parseMagnitudeEnvelope(input, "embedding");
  return freezeShadow({
    lineage: "embedding",
    receipt: "embed.observe.v1",
    correlation: "dup:embed-max-v1",
    envelope,
    snapshot: parseEmbeddingSnapshot(input.snapshot, envelope)
  });
}

function parseEmbeddingSnapshot(
  input: unknown,
  envelope: ShadowEnvelope
): ShadowEmbeddingScoreSnapshot {
  const record = requireShadowRecord(input, "embedding snapshot");
  assertAllowedKeys(record, ["status", "value", "domain", "content_hash"]);
  if (record.status !== envelope.state) {
    throw new ShadowContractError("embedding snapshot status mismatch");
  }
  if (envelope.state !== "observed") {
    if (record.value !== null) {
      throw new ShadowContractError("non-observed embedding cannot carry a value");
    }
    return freezeShadow({
      status: envelope.state,
      value: null,
      domain: record.domain === null ? null : parseEmbDomain(record.domain),
      content_hash: typeof record.content_hash === "string" ? record.content_hash : null
    });
  }
  if (envelope.value < 0 || envelope.value > 1 || record.value !== envelope.value) {
    throw new ShadowContractError("embedding observed value must be clamp01");
  }
  return freezeShadow({
    status: "observed",
    value: envelope.value,
    domain: parseEmbDomain(record.domain),
    content_hash: requireNonemptyString(record.content_hash, "content hash")
  });
}

function parseEmbDomain(input: unknown): EmbDomain {
  const record = requireShadowRecord(input, "EmbDomain");
  assertAllowedKeys(record, ["provider_kind", "model_id", "dimensions", "schema_version"]);
  const dimensions = requireInteger(record.dimensions, "dimensions");
  const schemaVersion = requireInteger(record.schema_version, "schema_version");
  if (dimensions <= 0 || schemaVersion < 0) {
    throw new ShadowContractError("invalid EmbDomain");
  }
  return freezeShadow({
    provider_kind: requireNonemptyString(record.provider_kind, "provider_kind"),
    model_id: requireNonemptyString(record.model_id, "model_id"),
    dimensions,
    schema_version: schemaVersion
  });
}

function parseTemporalObservation(input: Record<string, unknown>): ShadowTemporalObservation {
  assertReceipt(input, "temporal.observe.v1", "temporal.observe.v1", ["evaluator"]);
  const envelope = parseMagnitudeEnvelope(input, "temporal");
  return freezeShadow({
    lineage: "temporal",
    receipt: "temporal.observe.v1",
    correlation: "temporal.observe.v1",
    envelope,
    evaluator: parseTemporalEvaluator(input.evaluator, envelope)
  });
}

function parseTemporalEvaluator(
  input: unknown,
  envelope: ShadowEnvelope
): ShadowTemporalEvaluator {
  const record = requireShadowRecord(input, "temporal evaluator");
  assertAllowedKeys(record, [
    "applicable", "parse_state", "clock_state", "candidate_evaluated",
    "event_time", "domain", "finite_value"
  ]);
  const evaluator = freezeShadow({
    applicable: record.applicable === true,
    parse_state: parseTemporalParseState(record.parse_state),
    clock_state: parseClockState(record.clock_state),
    candidate_evaluated: record.candidate_evaluated === true,
    event_time: parseOptionalString(record.event_time),
    domain: record.domain === null ? null : parseTemporalDomain(record.domain),
    finite_value: record.finite_value === null ? null : finiteOrThrow(record.finite_value)
  });
  assertTemporalConsistency(envelope, evaluator);
  return evaluator;
}

function assertTemporalConsistency(
  envelope: ShadowEnvelope,
  evaluator: ShadowTemporalEvaluator
): void {
  if (evaluator.parse_state === "unparseable_date_terms") {
    if (evaluator.domain?.kind === "recency") {
      throw new ShadowContractError("unparseable window must not become recency");
    }
    if (envelope.state !== "not_observed") {
      throw new ShadowContractError("unparseable window is not_observed");
    }
  }
  if (envelope.state === "observed" &&
      (!evaluator.candidate_evaluated || evaluator.event_time === null ||
        evaluator.domain === null || evaluator.finite_value !== envelope.value)) {
    throw new ShadowContractError("temporal observed needs evaluation and event_time");
  }
}

function parseTemporalDomain(input: unknown): ShadowTemporalDomain {
  const record = requireShadowRecord(input, "temporal domain");
  if (record.kind === "window") {
    assertAllowedKeys(record, ["kind", "query_id", "start_ms", "end_ms", "decay_days"]);
    if (record.decay_days !== 90) {
      throw new ShadowContractError("invalid temporal window domain");
    }
    return freezeShadow({
      kind: "window",
      query_id: requireNonemptyString(record.query_id, "query_id"),
      start_ms: requireFiniteNumber(record.start_ms, "start_ms"),
      end_ms: requireFiniteNumber(record.end_ms, "end_ms"),
      decay_days: 90 as const
    });
  }
  if (record.kind === "recency") {
    assertAllowedKeys(record, ["kind", "query_id", "now_iso", "decay_days"]);
    if (record.decay_days !== 365) {
      throw new ShadowContractError("invalid temporal recency domain");
    }
    return freezeShadow({
      kind: "recency",
      query_id: requireNonemptyString(record.query_id, "query_id"),
      now_iso: requireNonemptyString(record.now_iso, "now_iso"),
      decay_days: 365 as const
    });
  }
  throw new ShadowContractError("temporal domain must be window or recency");
}

function parseSubjectObservation(input: Record<string, unknown>): ShadowSubjectObservation {
  assertReceipt(input, "subject.observe.v1", "subject.observe.v1", ["domain", "components"]);
  if (!Array.isArray(input.components)) {
    throw new ShadowContractError("subject components must be an array");
  }
  const components = Object.freeze(input.components.map(parseSubjectComponent));
  const combined = combineSubjectComponentEnvelopes(components);
  const envelope = parseShadowEnvelope(input.envelope);
  if (!sameEnvelope(envelope, combined)) {
    throw new ShadowContractError("subject envelope must match combined components");
  }
  return freezeShadow({
    lineage: "subject_preference",
    receipt: "subject.observe.v1",
    correlation: "subject.observe.v1",
    envelope,
    domain: parseSubjDomain(input.domain, components),
    components
  });
}

function parseSubjectComponent(input: unknown): ShadowSubjectComponent {
  const record = requireShadowRecord(input, "subject component");
  assertAllowedKeys(record, ["component_id", "operator_id", "envelope"]);
  if (typeof record.component_id !== "string" ||
      !SUBJECT_COMPONENT_IDS.has(record.component_id)) {
    throw new ShadowContractError("invalid subject component");
  }
  return freezeShadow({
    component_id: record.component_id as ShadowSubjectComponentId,
    operator_id: requireNonemptyString(record.operator_id, "operator_id"),
    envelope: parseShadowEnvelope(record.envelope)
  });
}

function parseSubjDomain(
  input: unknown,
  components: readonly ShadowSubjectComponent[]
): SubjDomain {
  const record = requireShadowRecord(input, "SubjDomain");
  assertAllowedKeys(record, ["query_id", "applicable_component_ids", "component_operator_ids"]);
  const applicable = requireStringList(record.applicable_component_ids, "applicable_component_ids");
  const operators = requireStringList(record.component_operator_ids, "component_operator_ids");
  if (applicable.some((id) => !SUBJECT_COMPONENT_IDS.has(id))) {
    throw new ShadowContractError("invalid applicable subject component id");
  }
  const live = components.filter((component) => component.envelope.state !== "not_applicable");
  if (!sameStringList(applicable, live.map((component) => component.component_id)) ||
      !sameStringList(operators, live.map((component) => component.operator_id))) {
    throw new ShadowContractError("SubjDomain must list applicable components");
  }
  return freezeShadow({
    query_id: requireNonemptyString(record.query_id, "query_id"),
    applicable_component_ids: Object.freeze(applicable) as readonly ShadowSubjectComponentId[],
    component_operator_ids: Object.freeze(operators)
  });
}

function parseMagnitudeEnvelope(
  input: Record<string, unknown>,
  lineage: ShadowLineageId
): ShadowEnvelope {
  const envelope = parseShadowEnvelope(input.envelope);
  if (envelope.state === "observed_negative" || envelope.state === "required_but_missing") {
    throw new ShadowContractError(
      `${lineage} cannot use ${envelope.state} as pointwise magnitude`
    );
  }
  return envelope;
}

function assertReceipt(
  input: Record<string, unknown>,
  receipt: string,
  correlation: string,
  extra: readonly string[]
): void {
  assertAllowedKeys(input, ["lineage", "receipt", "correlation", "envelope", ...extra]);
  if (input.receipt !== receipt || input.correlation !== correlation) {
    throw new ShadowContractError("observation receipt mismatch");
  }
}

function parseLexStatus(status: unknown, listN: number): LexListStatus {
  if (listN === 0) {
    if (status !== "empty") throw new ShadowContractError("empty LexDomain requires list_n = 0");
    return "empty";
  }
  if (status !== "complete" && status !== "truncated") {
    throw new ShadowContractError("non-empty LexDomain status is complete or truncated");
  }
  return status;
}

function observedValue(component: ShadowSubjectComponent): number {
  if (component.envelope.state !== "observed") {
    throw new ShadowContractError("subject max requires every applicable component observed");
  }
  return component.envelope.value;
}

function sameEnvelope(left: ShadowEnvelope, right: ShadowEnvelope): boolean {
  if (left.state !== right.state) return false;
  return left.state !== "observed" || right.state !== "observed" || left.value === right.value;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseOptionalString(value: unknown): string | null {
  if (value === null) return null;
  return requireNonemptyString(value, "optional string");
}

function finiteOrThrow(value: unknown): number {
  return requireFiniteNumber(value, "finite_value");
}

function parseTemporalParseState(value: unknown): ShadowTemporalEvaluator["parse_state"] {
  if (value === "window" || value === "unparseable_date_terms" ||
      value === "recency" || value === "not_applicable") {
    return value;
  }
  throw new ShadowContractError("invalid parse_state");
}

function parseClockState(value: unknown): "ok" | "unusable" {
  if (value === "ok" || value === "unusable") return value;
  throw new ShadowContractError("invalid clock_state");
}
