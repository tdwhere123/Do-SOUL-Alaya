import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  requireFiniteNumber,
  ShadowContractError
} from "../contract-primitives.js";

export const SHADOW_ENVELOPE_STATES = [
  "observed",
  "observed_negative",
  "required_but_missing",
  "not_applicable",
  "producer_unavailable",
  "not_observed"
] as const;

export type ShadowEnvelopeState = (typeof SHADOW_ENVELOPE_STATES)[number];

export type ShadowNamedNegativeConsumer =
  | "h_event"
  | "h_temporal"
  | "h_hidden"
  | "calibrated_negative";

export type ShadowNotObservedReason =
  | "not_run"
  | "truncated"
  | "cap_exhausted"
  | "frontier_exhausted"
  | "unknown_completeness"
  | "missing_rank"
  | "missing_event_time"
  | "unparseable_window"
  | "missing_vector"
  | "missing_authority"
  | "absent_from_list";

export type ShadowRequiredMissingWitnesses = Readonly<{
  readonly query_requires: true;
  readonly applicable: true;
  readonly producer_available: true;
  readonly candidate_evaluated: true;
  readonly completeness_owner: string;
  readonly evaluation_exhausted: true;
  readonly proven_absence: true;
}>;

export type ShadowObservedEnvelope = Readonly<{
  readonly state: "observed";
  readonly value: number;
}>;

export type ShadowObservedNegativeEnvelope = Readonly<{
  readonly state: "observed_negative";
  readonly named_consumer: ShadowNamedNegativeConsumer;
}>;

export type ShadowRequiredButMissingEnvelope = Readonly<{
  readonly state: "required_but_missing";
  readonly witnesses: ShadowRequiredMissingWitnesses;
}>;

export type ShadowNotApplicableEnvelope = Readonly<{
  readonly state: "not_applicable";
}>;

export type ShadowProducerUnavailableEnvelope = Readonly<{
  readonly state: "producer_unavailable";
}>;

export type ShadowNotObservedEnvelope = Readonly<{
  readonly state: "not_observed";
  readonly reason?: ShadowNotObservedReason;
}>;

export type ShadowEnvelope =
  | ShadowObservedEnvelope
  | ShadowObservedNegativeEnvelope
  | ShadowRequiredButMissingEnvelope
  | ShadowNotApplicableEnvelope
  | ShadowProducerUnavailableEnvelope
  | ShadowNotObservedEnvelope;

const NAMED_NEGATIVE_CONSUMERS: ReadonlySet<string> = new Set([
  "h_event",
  "h_temporal",
  "h_hidden",
  "calibrated_negative"
]);

const NOT_OBSERVED_REASONS: ReadonlySet<string> = new Set([
  "not_run",
  "truncated",
  "cap_exhausted",
  "frontier_exhausted",
  "unknown_completeness",
  "missing_rank",
  "missing_event_time",
  "unparseable_window",
  "missing_vector",
  "missing_authority",
  "absent_from_list"
]);

const FORBIDDEN_COMPLETENESS_OWNERS: ReadonlySet<string> = new Set([
  "truncated",
  "cap",
  "not_run",
  "unavailable"
]);

export function isObservedZero(envelope: ShadowEnvelope): boolean {
  return envelope.state === "observed" && envelope.value === 0;
}

export function isUnknownNeutral(state: ShadowEnvelopeState): boolean {
  return state === "not_applicable" ||
    state === "producer_unavailable" ||
    state === "not_observed";
}

export function isCmpIllegalState(state: ShadowEnvelopeState): boolean {
  return state === "observed_negative" || state === "required_but_missing";
}

export function parseShadowEnvelope(input: unknown): ShadowEnvelope {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("envelope must be an object");
  }
  const state = input.state;
  if (state === "observed") return parseObserved(input);
  if (state === "observed_negative") return parseObservedNegative(input);
  if (state === "required_but_missing") return parseRequiredButMissing(input);
  if (state === "not_applicable") return parseNotApplicable(input);
  if (state === "producer_unavailable") return parseProducerUnavailable(input);
  if (state === "not_observed") return parseNotObserved(input);
  throw new ShadowContractError("unknown envelope state");
}

function parseObserved(input: Record<string, unknown>): ShadowObservedEnvelope {
  assertAllowedKeys(input, ["state", "value"]);
  return freezeShadow({
    state: "observed",
    value: requireFiniteNumber(input.value, "observed value")
  });
}

function parseObservedNegative(
  input: Record<string, unknown>
): ShadowObservedNegativeEnvelope {
  assertAllowedKeys(input, ["state", "named_consumer"]);
  const consumer = input.named_consumer;
  if (typeof consumer !== "string" || !NAMED_NEGATIVE_CONSUMERS.has(consumer)) {
    throw new ShadowContractError("observed_negative needs a named consumer");
  }
  return freezeShadow({
    state: "observed_negative",
    named_consumer: consumer as ShadowNamedNegativeConsumer
  });
}

function parseRequiredButMissing(
  input: Record<string, unknown>
): ShadowRequiredButMissingEnvelope {
  assertAllowedKeys(input, ["state", "witnesses"]);
  return freezeShadow({
    state: "required_but_missing",
    witnesses: parseRequiredMissingWitnesses(input.witnesses)
  });
}

function parseRequiredMissingWitnesses(value: unknown): ShadowRequiredMissingWitnesses {
  if (!isShadowRecord(value)) {
    throw new ShadowContractError("required_but_missing needs witnesses");
  }
  const flags = [
    "query_requires",
    "applicable",
    "producer_available",
    "candidate_evaluated",
    "evaluation_exhausted",
    "proven_absence"
  ] as const;
  for (const flag of flags) {
    if (value[flag] !== true) {
      throw new ShadowContractError(
        `required_but_missing rejected without ${flag}`
      );
    }
  }
  const owner = value.completeness_owner;
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new ShadowContractError(
      "required_but_missing rejected without completeness witness"
    );
  }
  if (FORBIDDEN_COMPLETENESS_OWNERS.has(owner) || value.truncated === true) {
    throw new ShadowContractError("truncation is not a completeness witness");
  }
  assertAllowedKeys(value, [...flags, "completeness_owner"]);
  return freezeShadow({
    query_requires: true,
    applicable: true,
    producer_available: true,
    candidate_evaluated: true,
    completeness_owner: owner,
    evaluation_exhausted: true,
    proven_absence: true
  });
}

function parseNotApplicable(
  input: Record<string, unknown>
): ShadowNotApplicableEnvelope {
  assertAllowedKeys(input, ["state"]);
  return freezeShadow({ state: "not_applicable" });
}

function parseProducerUnavailable(
  input: Record<string, unknown>
): ShadowProducerUnavailableEnvelope {
  assertAllowedKeys(input, ["state"]);
  return freezeShadow({ state: "producer_unavailable" });
}

function parseNotObserved(input: Record<string, unknown>): ShadowNotObservedEnvelope {
  assertAllowedKeys(input, ["state", "reason"]);
  if (input.reason === undefined) return freezeShadow({ state: "not_observed" });
  if (typeof input.reason !== "string" || !NOT_OBSERVED_REASONS.has(input.reason)) {
    throw new ShadowContractError("invalid not_observed reason");
  }
  return freezeShadow({
    state: "not_observed",
    reason: input.reason as ShadowNotObservedReason
  });
}
