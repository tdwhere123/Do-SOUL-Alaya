import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import type { ChannelClosureResult } from "../../closure/contract.js";
import { verifyChannelClosureResult } from "../../closure/verify.js";
import {
  captureData,
  captureVerifiedLiveClosureAuthority,
  type LiveClosureAuthorityBinding,
  type VerifiedLiveClosureAuthorityCapture
} from
  "../../closure/live-authority-binding.js";
import {
  decisionTraceSortKey,
  digestFiniteFixture,
  digestFiniteManifest,
  normalizeFiniteFixture,
  normalizeDecisionTrace,
  type FiniteDecisionTrace,
  type FiniteOracleFixture
} from "../oracle/contract.js";
import {
  abstractResultIdentity,
  assertIdentity,
  captureAbstractProofKernelInput,
  sealAbstractRefusalResult,
  type AbstractCoordinate,
  type AbstractDecisionOperator,
  type AbstractOperatorEvaluation,
  type AbstractProofKernelInput,
  type AbstractProofKernelResult,
  type AbstractRefinementRequest
} from "./contract.js";
import { normalizeAbstractCoordinates } from "./coordinate-schema.js";
import {
  isConflictCoordinate,
  isDecisionOpenCoordinate,
  isStrictlyOpenCoordinate,
  strictOpenReason
} from "./domain-state.js";
import {
  assertExactKeys,
  validateAbstractKernelInput,
  validateFixtureAbstractCoverage
} from "./input-validation.js";
import {
  joinChannelRemainingEffects,
  type ScopedRemainingEffect
} from "./domain-join.js";

export function evaluateAbstractProofKernel(
  input: AbstractProofKernelInput
): AbstractProofKernelResult {
  const evaluation = evaluateAbstractSingletonCandidate(input);
  if (evaluation.kind === "result") return evaluation.result;
  const requests = mergeRequests(evaluation.coordinates.filter(isDecisionOpenCoordinate)
    .map((coordinate) => requestFor(coordinate, "finite oracle certificate required")));
  return open(evaluation.input, "finite oracle differential certificate required",
    requests, [evaluation.outcome], evaluation.live_binding);
}

export function evaluateAbstractSingletonCandidate(
  input: AbstractProofKernelInput
): KernelEvaluation {
  let stableInput: AbstractProofKernelInput;
  try {
    stableInput = captureAbstractProofKernelInput(input);
  } catch (error) {
    return resultEvaluation(invalidInputUnsupported(messageOf(error)));
  }
  let captured: VerifiedLiveClosureAuthorityCapture;
  try {
    captured = captureVerifiedLiveClosureAuthority(stableInput.live_authority);
  } catch (error) {
    return resultEvaluation(unsupported(stableInput, messageOf(error)));
  }
  const preparation = prepareAbstractDomain(stableInput, captured);
  return preparation.kind === "result"
    ? Object.freeze({ kind: "result" as const, result: preparation.result })
    : evaluatePreparedKernel(preparation);
}

type PreparedKernel = Readonly<{
  readonly kind: "prepared";
  readonly input: AbstractProofKernelInput;
  readonly coordinates: readonly AbstractCoordinate[];
  readonly remaining_effects:
    AbstractProofKernelInput["closures"][number]["remaining_effects"];
  readonly fixture: FiniteOracleFixture;
  readonly transfer_digest: ReturnType<typeof digestRecallFieldIdentity>;
  readonly live_binding: LiveClosureAuthorityBinding;
}>;

export type KernelEvaluation = Readonly<{
  readonly kind: "singleton_candidate";
  readonly input: AbstractProofKernelInput;
  readonly coordinates: readonly AbstractCoordinate[];
  readonly outcome: FiniteDecisionTrace;
  readonly live_binding: LiveClosureAuthorityBinding;
}> | Readonly<{
  readonly kind: "result";
  readonly result: AbstractProofKernelResult;
}>;

type KernelPreparation = PreparedKernel | Readonly<{
  readonly kind: "result";
  readonly result: AbstractProofKernelResult;
}>;

function prepareAbstractDomain(
  input: AbstractProofKernelInput,
  captured: VerifiedLiveClosureAuthorityCapture
): KernelPreparation {
  const binding = captured.binding;
  const invalid = validateAbstractKernelInput(input, binding);
  if (invalid !== null) return preparedResult(unsupported(input, invalid, binding));
  const fixture = normalizeFiniteFixture(input.fixture);
  const sensitivityCount = new Set(fixture.coordinates.map(({ sensitivity_id }) =>
    sensitivity_id)).size;
  if (input.closures.length > input.limits.max_channels ||
      input.coordinates.length > input.limits.max_coordinates ||
      sensitivityCount > input.limits.max_sensitivities) {
    return preparedResult(unsupported(input, "declared abstract domain limit exceeded",
      binding));
  }
  let coordinates: readonly AbstractCoordinate[];
  try {
    coordinates = normalizeAbstractCoordinates(input.coordinates);
  } catch (error) {
    return preparedResult(unsupported(input, messageOf(error), binding));
  }
  const normalizedInput = Object.freeze({ ...input,
    live_authority: captured.authority, fixture, coordinates });
  const conflicts = coordinates.filter(isConflictCoordinate);
  if (conflicts.length > 0) {
    return preparedResult(conflict(normalizedInput,
      conflicts.map(({ coordinate_id }) => coordinate_id),
      "abstract proposition conflict", binding));
  }
  const closureValidation = validateClosures(input, captured);
  if (closureValidation.requests.length > 0) {
    return preparedResult(open(normalizedInput,
      "unresolved or invalid channel closure", closureValidation.requests, [], binding));
  }
  const transferMismatch = validateFixtureAbstractCoverage(fixture, coordinates);
  if (transferMismatch !== null) {
    return preparedResult(unsupported(normalizedInput, transferMismatch, binding));
  }
  const scopedEffects = collectScopedEffects(closureValidation.closures);
  const joined = joinChannelRemainingEffects(coordinates, scopedEffects);
  const effectiveInput = Object.freeze({ ...normalizedInput,
    coordinates: joined.coordinates });
  const strictRequests = joined.coordinates.filter(isStrictlyOpenCoordinate)
    .map((coordinate) => requestFor(coordinate, strictOpenReason(coordinate)));
  const preOperatorRequests = mergeRequests([
    ...joined.requested_refinements,
    ...strictRequests
  ]);
  if (preOperatorRequests.length > 0) {
    return preparedResult(open(effectiveInput,
      "unresolved channel or abstract domain", preOperatorRequests, [], binding));
  }
  const remainingEffects = Object.freeze(scopedEffects.map(({ effect }) => effect));
  return Object.freeze({
    kind: "prepared" as const,
    input: effectiveInput,
    coordinates: joined.coordinates,
    remaining_effects: remainingEffects,
    fixture,
    transfer_digest: digestRecallFieldIdentity({
      authority_digest: abstractResultIdentity(effectiveInput, binding).authority_digest,
      fixture_digest: digestFiniteFixture(fixture),
      concrete_operator_id: input.concrete_operator.operator_id,
      abstract_operator_id: input.operator.operator_id,
      manifest_digest: digestFiniteManifest(fixture)
    }),
    live_binding: binding
  });
}

function evaluatePreparedKernel(prepared: PreparedKernel): KernelEvaluation {
  const { input, coordinates, remaining_effects: remainingEffects,
    live_binding: binding } = prepared;
  let evaluation: AbstractOperatorEvaluation;
  try {
    evaluation = evaluateDeterministically(input.operator.evaluate, coordinates,
      remainingEffects, input.k_max, prepared.transfer_digest);
    validateOperatorEvaluation(evaluation);
  } catch (error) {
    return resultEvaluation(unsupported(input, messageOf(error), binding));
  }
  if (evaluation.status === "conflict") {
    return resultEvaluation(conflict(input, [], evaluation.reason, binding));
  }
  if (evaluation.status === "unsupported") {
    return resultEvaluation(unsupported(input, evaluation.reason, binding));
  }
  const handled = new Set(evaluation.handled_sensitivity_ids);
  const manifest = new Set(prepared.fixture.coordinates.map(({ sensitivity_id }) =>
    sensitivity_id));
  if ([...handled].some((sensitivityId) => !manifest.has(sensitivityId))) {
    return resultEvaluation(unsupported(input,
      "abstract operator handled sensitivities outside the finite manifest", binding));
  }
  const missingManifest = prepared.fixture.coordinates.filter(({ sensitivity_id }) =>
    !handled.has(sensitivity_id));
  if (missingManifest.length > 0) {
    return resultEvaluation(open(input,
      "abstract operator did not handle complete sensitivity manifest",
      requestsForManifest(missingManifest, coordinates), [], binding));
  }
  let outcomes: readonly FiniteDecisionTrace[];
  try {
    outcomes = normalizeOutcomes(evaluation.outcomes, input.k_max);
  } catch (error) {
    return resultEvaluation(unsupported(input, messageOf(error), binding));
  }
  if (outcomes.length === 0) {
    return resultEvaluation(unsupported(input, "abstract operator returned no outcome",
      binding));
  }
  if (outcomes.length === 1) {
    return Object.freeze({
      kind: "singleton_candidate" as const,
      input,
      coordinates,
      outcome: outcomes[0]!,
      live_binding: binding
    });
  }
  const requests = mergeRequests(coordinates.filter(isDecisionOpenCoordinate)
    .map((coordinate) => requestFor(coordinate, "multiple abstract outcomes")));
  if (requests.length === 0) {
    return resultEvaluation(unsupported(input,
      "multiple outcomes lack a decision-changing coordinate", binding));
  }
  return Object.freeze({ kind: "result" as const,
    result: open(input, "multiple abstract outcomes", requests, outcomes, binding) });
}

function preparedResult(result: AbstractProofKernelResult): KernelPreparation {
  return Object.freeze({ kind: "result", result });
}

function resultEvaluation(result: AbstractProofKernelResult): KernelEvaluation {
  return Object.freeze({ kind: "result", result });
}

type ClosureValidation = Readonly<{
  readonly closures: readonly ChannelClosureResult[];
  readonly requests: readonly AbstractRefinementRequest[];
}>;

function validateClosures(
  input: AbstractProofKernelInput,
  captured: VerifiedLiveClosureAuthorityCapture
): ClosureValidation {
  const requests: AbstractRefinementRequest[] = [];
  const closures: ChannelClosureResult[] = [];
  for (const closure of input.closures) {
    try {
      const verified = verifyChannelClosureResult(closure,
        captured.source_authority);
      closures.push(verified);
      if (verified.status === "uncertified") {
        requests.push(channelRequest(verified.channel_id, verified.reason));
      }
    } catch {
      requests.push(channelRequest(safeChannelId(closure),
        "closure receipt digest mismatch"));
    }
  }
  return Object.freeze({
    closures: Object.freeze(closures),
    requests: mergeRequests(requests)
  });
}

function safeChannelId(value: unknown): string {
  if (typeof value === "object" && value !== null && "channel_id" in value &&
      typeof value.channel_id === "string" && value.channel_id.length > 0) {
    return value.channel_id;
  }
  return "invalid-channel";
}

function collectScopedEffects(
  closures: readonly ChannelClosureResult[]
): readonly ScopedRemainingEffect[] {
  return Object.freeze(closures.flatMap((closure) =>
    closure.remaining_effects.map((effect) => Object.freeze({
      owner_id: closure.channel_id,
      effect
    }))).sort((left, right) =>
      compareText(left.effect.sensitivity_id, right.effect.sensitivity_id) ||
      compareText(left.owner_id, right.owner_id) ||
      compareText(left.effect.effect_id, right.effect.effect_id)));
}

function evaluateDeterministically(
  evaluate: AbstractDecisionOperator["evaluate"],
  coordinates: readonly AbstractCoordinate[],
  remainingEffects: AbstractProofKernelInput["closures"][number]["remaining_effects"],
  kMax: number,
  transferDigest: ReturnType<typeof digestRecallFieldIdentity>
): AbstractOperatorEvaluation {
  const input = Object.freeze({
    coordinates,
    remaining_effects: remainingEffects,
    k_max: kMax,
    transfer_digest: transferDigest
  });
  const first = captureData(evaluate(input));
  const replay = captureData(evaluate(input));
  if (digestRecallFieldIdentity(first) !== digestRecallFieldIdentity(replay)) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "abstract operator is not deterministic"
    });
  }
  return first;
}

function validateOperatorEvaluation(evaluation: AbstractOperatorEvaluation): void {
  if (evaluation.status === "conflict" || evaluation.status === "unsupported") {
    assertExactKeys(evaluation, ["status", "reason"], "abstract operator refusal");
    assertIdentity(evaluation.reason, "abstract operator refusal reason");
    return;
  }
  assertExactKeys(evaluation, [
    "status", "handled_sensitivity_ids", "outcomes"
  ], "abstract operator outcomes");
  if (evaluation.status !== "outcomes" ||
      !Array.isArray(evaluation.handled_sensitivity_ids) ||
      !Array.isArray(evaluation.outcomes)) {
    throw new Error("abstract operator evaluation is invalid");
  }
  evaluation.handled_sensitivity_ids.forEach((sensitivityId) =>
    assertIdentity(sensitivityId, "abstract operator handled sensitivity"));
  if (new Set(evaluation.handled_sensitivity_ids).size !==
      evaluation.handled_sensitivity_ids.length) {
    throw new Error("abstract operator handled sensitivities must be unique");
  }
}

function normalizeOutcomes(
  outcomes: Extract<AbstractOperatorEvaluation, { status: "outcomes" }>["outcomes"],
  kMax: number
): readonly FiniteDecisionTrace[] {
  const unique = new Map<string, FiniteDecisionTrace>();
  for (const outcome of outcomes) {
    const normalized = normalizeDecisionTrace(outcome, kMax);
    unique.set(normalized.trace_digest, normalized);
  }
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareText(decisionTraceSortKey(left), decisionTraceSortKey(right))));
}

function requestsForManifest(
  rows: readonly {
    readonly coordinate_id: string;
    readonly sensitivity_id: string;
    readonly owner_id: string;
  }[],
  coordinates: readonly AbstractCoordinate[]
): readonly AbstractRefinementRequest[] {
  return mergeRequests(rows.map((row) => {
    const coordinate = coordinates.find(({ sensitivity_id }) =>
      sensitivity_id === row.sensitivity_id);
    return coordinate === undefined
      ? Object.freeze({
          coordinate_id: row.coordinate_id,
          sensitivity_id: row.sensitivity_id,
          owner_id: row.owner_id,
          domain_kind: "channel_closure" as const,
          reason: "manifest sensitivity is unhandled"
        })
      : requestFor(coordinate, "manifest sensitivity is unhandled");
  }));
}

function requestFor(
  coordinate: AbstractCoordinate,
  reason: string
): AbstractRefinementRequest {
  return Object.freeze({
    coordinate_id: coordinate.coordinate_id,
    sensitivity_id: coordinate.sensitivity_id,
    owner_id: coordinate.owner_id,
    domain_kind: coordinate.kind,
    reason
  });
}

function channelRequest(channelId: string, reason: string): AbstractRefinementRequest {
  return Object.freeze({
    coordinate_id: `channel:${channelId}`,
    sensitivity_id: `channel:${channelId}:closure`,
    owner_id: channelId,
    domain_kind: "channel_closure",
    reason
  });
}

function mergeRequests(
  requests: readonly AbstractRefinementRequest[]
): readonly AbstractRefinementRequest[] {
  const unique = new Map(requests.map((request) => [
    `${request.owner_id}\u0000${request.sensitivity_id}\u0000${request.coordinate_id}`,
    request
  ]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareText(left.sensitivity_id, right.sensitivity_id) ||
    compareText(left.owner_id, right.owner_id) ||
    compareText(left.coordinate_id, right.coordinate_id)));
}

function open(
  input: AbstractProofKernelInput,
  reason: string,
  requests: readonly AbstractRefinementRequest[],
  outcomes: readonly FiniteDecisionTrace[],
  binding?: LiveClosureAuthorityBinding
): Extract<AbstractProofKernelResult, { status: "OPEN" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input, binding),
    status: "OPEN" as const,
    reason,
    requested_refinements: requests,
    possible_outcomes: outcomes
  });
}

function conflict(
  input: AbstractProofKernelInput,
  coordinateIds: readonly string[],
  reason: string,
  binding?: LiveClosureAuthorityBinding
): Extract<AbstractProofKernelResult, { status: "CONFLICT" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input, binding),
    status: "CONFLICT" as const,
    reason,
    conflict_coordinate_ids: Object.freeze([...coordinateIds].sort(compareText))
  });
}

function unsupported(
  input: AbstractProofKernelInput,
  reason: string,
  binding?: LiveClosureAuthorityBinding
): Extract<AbstractProofKernelResult, { status: "UNSUPPORTED" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input, binding),
    status: "UNSUPPORTED" as const,
    reason
  });
}

function invalidInputUnsupported(
  reason: string
): Extract<AbstractProofKernelResult, { status: "UNSUPPORTED" }> {
  const invalid = digestRecallFieldIdentity({
    operator_id: "invalid_abstract_kernel_input",
    reason
  });
  return sealAbstractRefusalResult({
    schema_version: 1 as const,
    operator_id: "operator_parametric_abstract_proof_kernel_v1" as const,
    authority_digest: invalid,
    query_digest: invalid,
    snapshot_digest: invalid,
    principal_digest: invalid,
    decision_operator_id: "unverified_abstract_operator",
    concrete_operator_id: "unverified_concrete_operator",
    fixture_digest: invalid,
    transfer_digest: invalid,
    manifest_digest: invalid,
    k_max: 0,
    premise_digest: invalid,
    status: "UNSUPPORTED" as const,
    reason
  });
}


function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "abstract kernel input is invalid";
}
