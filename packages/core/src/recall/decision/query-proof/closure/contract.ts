import { compareText } from "../../../../shared/compare-text.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../../field/field-identity.js";

export const CHANNEL_CLOSURE_OPERATOR_ID =
  "query_proof_channel_closure_v1";
export const CLOSURE_SCOPE_BINDING_OPERATOR_ID =
  "query_proof_closure_scope_binding_v1";
export const FINITE_CLOSURE_UNIVERSE_OPERATOR_ID =
  "query_proof_finite_closure_universe_v1";

export type ChannelClosureStatus =
  | "not_applicable"
  | "exact_closed"
  | "bounded_open"
  | "uncertified";

export type ClosureSensitivityEffect =
  | "proposition_bound"
  | "feasibility_change"
  | "answer_binding"
  | "answer_position"
  | "extremum_interval"
  | "correlation_group"
  | "tie_winner_membership";

export type ClosureQuerySensitivity = Readonly<{
  readonly sensitivity_id: string;
  readonly effect: ClosureSensitivityEffect;
  readonly target: string;
}>;

export type ChannelClosureScope = Readonly<{
  readonly query_digest: RecallFieldDigest;
  readonly request_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly workspace_id: string;
  readonly observer_id: string;
  readonly channel_id: string;
  readonly domain_id: string;
  readonly universe_digest: RecallFieldDigest;
  readonly sensitivities: readonly ClosureQuerySensitivity[];
}>;

type EffectIdentity = Readonly<{
  readonly effect_id: string;
  readonly sensitivity_id: string;
}>;

export type ChannelRemainingEffect =
  | (EffectIdentity & Readonly<{
      readonly effect: "proposition_bound" | "extremum_interval";
      readonly lower: number;
      readonly upper: number;
    }>)
  | (EffectIdentity & Readonly<{
      readonly effect: "feasibility_change";
      readonly possible_states: readonly ("feasible" | "infeasible" | "unresolved")[];
    }>)
  | (EffectIdentity & Readonly<{
      readonly effect: "answer_binding";
      readonly possible_bindings: readonly string[];
    }>)
  | (EffectIdentity & Readonly<{
      readonly effect: "answer_position";
      readonly minimum_position: number;
      readonly maximum_position: number;
    }>)
  | (EffectIdentity & Readonly<{
      readonly effect: "correlation_group";
      readonly possible_relations: readonly ("same_group" | "different_group")[];
    }>)
  | (EffectIdentity & Readonly<{
      readonly effect: "tie_winner_membership";
      readonly possible_winner_digests: readonly RecallFieldDigest[];
    }>);

export type ClosureReceiptScopeBinding = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof CLOSURE_SCOPE_BINDING_OPERATOR_ID;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly scope_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly binding_digest: RecallFieldDigest;
}>;

export type FiniteClosureUniverseWitness = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof FINITE_CLOSURE_UNIVERSE_OPERATOR_ID;
  readonly scope_digest: RecallFieldDigest;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly candidate_key_domain: string;
  readonly eligible_candidate_keys: readonly string[];
  readonly witness_digest: RecallFieldDigest;
}>;

export type ScopedCompletenessReference = Readonly<{
  readonly receipt_id: "query_proof_scoped_completeness_v1";
  readonly source_receipt_digest: RecallFieldDigest;
  readonly scope_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly domain_id: string;
  readonly coordinate_id: string;
  readonly reference_digest: RecallFieldDigest;
}>;

export type ChannelClosureResult = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof CHANNEL_CLOSURE_OPERATOR_ID;
  readonly status: ChannelClosureStatus;
  readonly scope_digest: RecallFieldDigest;
  readonly query_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly principal_digest: RecallFieldDigest;
  readonly observer_id: string;
  readonly channel_id: string;
  readonly domain_id: string;
  readonly universe_digest: RecallFieldDigest;
  readonly remaining_effects: readonly ChannelRemainingEffect[];
  readonly completeness_refs: readonly ScopedCompletenessReference[];
  readonly reason: string;
  readonly result_digest: RecallFieldDigest;
}>;

export function bindClosureReceiptScope(params: Readonly<{
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
}>): ClosureReceiptScopeBinding {
  const scope = freezeClosureScope(params.scope);
  assertDigest(params.source_receipt_digest, "closure source receipt");
  assertDigest(params.universe_digest, "closure universe");
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: CLOSURE_SCOPE_BINDING_OPERATOR_ID,
    source_receipt_digest: params.source_receipt_digest,
    scope_digest: digestClosureScope(scope),
    universe_digest: params.universe_digest
  });
  return Object.freeze({
    ...body,
    binding_digest: digestRecallFieldIdentity(body)
  });
}

export function closureBindingApplies(params: Readonly<{
  readonly binding: ClosureReceiptScopeBinding;
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly universe_digest?: RecallFieldDigest;
}>): boolean {
  try {
    const expected = bindClosureReceiptScope({
      scope: params.scope,
      source_receipt_digest: params.source_receipt_digest,
      universe_digest: params.universe_digest ?? params.scope.universe_digest
    });
    return expected.binding_digest === params.binding.binding_digest &&
      expected.scope_digest === params.binding.scope_digest &&
      expected.source_receipt_digest === params.binding.source_receipt_digest &&
      expected.universe_digest === params.binding.universe_digest;
  } catch {
    return false;
  }
}

export function createFiniteClosureUniverseWitness(params: Readonly<{
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly candidate_key_domain: string;
  readonly eligible_candidate_keys: readonly string[];
}>): FiniteClosureUniverseWitness {
  const scope = freezeClosureScope(params.scope);
  assertDigest(params.source_receipt_digest, "finite universe source receipt");
  assertIdentity(params.candidate_key_domain, "finite universe candidate domain");
  const eligible = freezeIdentities(
    params.eligible_candidate_keys,
    "finite universe candidate key"
  );
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: FINITE_CLOSURE_UNIVERSE_OPERATOR_ID,
    scope_digest: digestClosureScope(scope),
    source_receipt_digest: params.source_receipt_digest,
    universe_digest: scope.universe_digest,
    candidate_key_domain: params.candidate_key_domain,
    eligible_candidate_keys: eligible
  });
  return Object.freeze({
    ...body,
    witness_digest: digestRecallFieldIdentity(body)
  });
}

export function finiteUniverseApplies(params: Readonly<{
  readonly witness: FiniteClosureUniverseWitness;
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digest: RecallFieldDigest;
}>): boolean {
  try {
    const expected = createFiniteClosureUniverseWitness({
      scope: params.scope,
      source_receipt_digest: params.source_receipt_digest,
      candidate_key_domain: params.witness.candidate_key_domain,
      eligible_candidate_keys: params.witness.eligible_candidate_keys
    });
    return expected.witness_digest === params.witness.witness_digest &&
      expected.universe_digest === params.witness.universe_digest;
  } catch {
    return false;
  }
}

export function createScopedCompletenessReference(params: Readonly<{
  readonly scope: ChannelClosureScope;
  readonly source_receipt_digest: RecallFieldDigest;
  readonly universe_digest: RecallFieldDigest;
  readonly coordinate_id: string;
}>): ScopedCompletenessReference {
  const scope = freezeClosureScope(params.scope);
  assertDigest(params.source_receipt_digest, "completeness source receipt");
  assertDigest(params.universe_digest, "completeness universe");
  assertIdentity(params.coordinate_id, "completeness coordinate");
  const body = Object.freeze({
    receipt_id: "query_proof_scoped_completeness_v1" as const,
    source_receipt_digest: params.source_receipt_digest,
    scope_digest: digestClosureScope(scope),
    universe_digest: params.universe_digest,
    domain_id: scope.domain_id,
    coordinate_id: params.coordinate_id
  });
  return Object.freeze({
    ...body,
    reference_digest: digestRecallFieldIdentity(body)
  });
}

export function createChannelClosureResult(params: Readonly<{
  readonly scope: ChannelClosureScope;
  readonly status: ChannelClosureStatus;
  readonly remaining_effects?: readonly ChannelRemainingEffect[];
  readonly completeness_refs?: readonly ScopedCompletenessReference[];
  readonly reason: string;
}>): ChannelClosureResult {
  const scope = freezeClosureScope(params.scope);
  const effects = freezeEffects(params.remaining_effects ?? [], scope.sensitivities);
  const refs = freezeCompletenessReferences(params.completeness_refs ?? [], scope);
  assertClosureStatusPayload(params.status, effects, refs);
  assertIdentity(params.reason, "closure reason");
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: CHANNEL_CLOSURE_OPERATOR_ID,
    status: params.status,
    scope_digest: digestClosureScope(scope),
    query_digest: scope.query_digest,
    snapshot_digest: scope.snapshot_digest,
    principal_digest: scope.principal_digest,
    observer_id: scope.observer_id,
    channel_id: scope.channel_id,
    domain_id: scope.domain_id,
    universe_digest: scope.universe_digest,
    remaining_effects: effects,
    completeness_refs: refs,
    reason: params.reason
  });
  return Object.freeze({
    ...body,
    result_digest: digestRecallFieldIdentity(body)
  });
}

export function uncertifiedClosure(
  scope: ChannelClosureScope,
  reason: string
): ChannelClosureResult {
  return createChannelClosureResult({ scope, status: "uncertified", reason });
}

export function digestClosureScope(scope: ChannelClosureScope): RecallFieldDigest {
  return digestRecallFieldIdentity(freezeClosureScope(scope));
}

function freezeClosureScope(scope: ChannelClosureScope): ChannelClosureScope {
  for (const [value, name] of [
    [scope.query_digest, "query"],
    [scope.request_digest, "request"],
    [scope.snapshot_digest, "snapshot"],
    [scope.principal_digest, "principal"],
    [scope.universe_digest, "universe"]
  ] as const) assertDigest(value, `closure ${name}`);
  for (const [value, name] of [
    [scope.workspace_id, "workspace"],
    [scope.observer_id, "observer"],
    [scope.channel_id, "channel"],
    [scope.domain_id, "domain"]
  ] as const) assertIdentity(value, `closure ${name}`);
  const sensitivities = scope.sensitivities.map((sensitivity) => {
    assertIdentity(sensitivity.sensitivity_id, "closure sensitivity id");
    assertIdentity(sensitivity.target, "closure sensitivity target");
    if (!SENSITIVITY_EFFECTS.has(sensitivity.effect)) {
      throw new Error("closure sensitivity effect is invalid");
    }
    return Object.freeze({ ...sensitivity });
  }).sort((left, right) => compareText(left.sensitivity_id, right.sensitivity_id));
  if (new Set(sensitivities.map(({ sensitivity_id }) => sensitivity_id)).size !==
      sensitivities.length) {
    throw new Error("closure sensitivity ids must be unique");
  }
  return Object.freeze({ ...scope, sensitivities: Object.freeze(sensitivities) });
}

function freezeEffects(
  effects: readonly ChannelRemainingEffect[],
  sensitivities: readonly ClosureQuerySensitivity[]
): readonly ChannelRemainingEffect[] {
  const sensitivityById = new Map(sensitivities.map((row) => [row.sensitivity_id, row]));
  const frozen = effects.map((effect) => {
    assertIdentity(effect.effect_id, "remaining effect id");
    const sensitivity = sensitivityById.get(effect.sensitivity_id);
    if (sensitivity?.effect !== effect.effect) {
      throw new Error("remaining effect is outside CQ_q sensitivities");
    }
    return normalizeChannelRemainingEffect(effect);
  }).sort((left, right) => compareText(left.effect_id, right.effect_id));
  if (new Set(frozen.map(({ effect_id }) => effect_id)).size !== frozen.length) {
    throw new Error("remaining effect ids must be unique");
  }
  return Object.freeze(frozen);
}

export function normalizeChannelRemainingEffect(
  effect: ChannelRemainingEffect
): ChannelRemainingEffect {
  assertIdentity(effect.effect_id, "remaining effect id");
  assertIdentity(effect.sensitivity_id, "remaining effect sensitivity id");
  if (effect.effect === "proposition_bound" || effect.effect === "extremum_interval") {
    assertInterval(effect.lower, effect.upper, "remaining numeric effect");
    return Object.freeze({ ...effect });
  }
  if (effect.effect === "answer_position") {
    if (!Number.isSafeInteger(effect.minimum_position) ||
        !Number.isSafeInteger(effect.maximum_position) ||
        effect.minimum_position < 0 || effect.maximum_position < effect.minimum_position) {
      throw new Error("remaining answer position is invalid");
    }
    return Object.freeze({ ...effect });
  }
  if (effect.effect === "answer_binding") {
    if (effect.possible_bindings.length === 0) {
      throw new Error("remaining answer binding values must be nonempty");
    }
    return Object.freeze({ ...effect,
      possible_bindings: freezeIdentities(effect.possible_bindings, "answer binding") });
  }
  if (effect.effect === "tie_winner_membership") {
    if (effect.possible_winner_digests.length === 0) {
      throw new Error("remaining tie winner values must be nonempty");
    }
    effect.possible_winner_digests.forEach((value) =>
      assertDigest(value, "possible tie winner"));
    return Object.freeze({ ...effect,
      possible_winner_digests: Object.freeze([...new Set(effect.possible_winner_digests)]
        .sort(compareText)) });
  }
  if (effect.effect === "feasibility_change") {
    if (effect.possible_states.length === 0 ||
        new Set(effect.possible_states).size !== effect.possible_states.length) {
      throw new Error("remaining finite effect values must be nonempty and unique");
    }
    return Object.freeze({ ...effect,
      possible_states: Object.freeze([...effect.possible_states].sort(compareText)) });
  }
  if (effect.effect === "correlation_group") {
    if (effect.possible_relations.length === 0 ||
        new Set(effect.possible_relations).size !== effect.possible_relations.length) {
      throw new Error("remaining finite effect values must be nonempty and unique");
    }
    return Object.freeze({ ...effect,
      possible_relations: Object.freeze([...effect.possible_relations].sort(compareText)) });
  }
  throw new Error("remaining effect kind is invalid");
}

function freezeCompletenessReferences(
  references: readonly ScopedCompletenessReference[],
  scope: ChannelClosureScope
): readonly ScopedCompletenessReference[] {
  const expectedScope = digestClosureScope(scope);
  return Object.freeze(references.map((reference) => {
    const { reference_digest: _digest, ...body } = reference;
    if (reference.scope_digest !== expectedScope ||
        reference.domain_id !== scope.domain_id ||
        reference.reference_digest !== digestRecallFieldIdentity(body)) {
      throw new Error("scoped completeness reference binding mismatch");
    }
    return Object.freeze({ ...reference });
  }).sort((left, right) => compareText(left.reference_digest, right.reference_digest)));
}

export function assertClosureStatusPayload(
  status: ChannelClosureStatus,
  effects: readonly ChannelRemainingEffect[],
  refs: readonly ScopedCompletenessReference[]
): void {
  if (status === "bounded_open" && effects.length === 0) {
    throw new Error("bounded-open closure requires remaining effects");
  }
  if (status !== "bounded_open" && effects.length > 0) {
    throw new Error("only bounded-open closure may carry remaining effects");
  }
  if (status === "exact_closed" && refs.length === 0) {
    throw new Error("exact-closed closure requires scoped completeness");
  }
  if ((status === "not_applicable" || status === "uncertified") && refs.length > 0) {
    throw new Error(`${status} closure cannot carry completeness references`);
  }
}

function freezeIdentities(values: readonly string[], field: string): readonly string[] {
  const output = values.map((value) => {
    assertIdentity(value, field);
    return value;
  }).sort(compareText);
  if (new Set(output).size !== output.length) throw new Error(`${field} must be unique`);
  return Object.freeze(output);
}

function assertInterval(lower: number, upper: number, field: string): void {
  if (![lower, upper].every(Number.isFinite) || upper < lower) {
    throw new Error(`${field} is invalid`);
  }
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty canonical identity`);
  }
}

function assertDigest(value: string, field: string): asserts value is RecallFieldDigest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} must be sha256`);
}

const SENSITIVITY_EFFECTS: ReadonlySet<string> = new Set([
  "proposition_bound",
  "feasibility_change",
  "answer_binding",
  "answer_position",
  "extremum_interval",
  "correlation_group",
  "tie_winner_membership"
]);
