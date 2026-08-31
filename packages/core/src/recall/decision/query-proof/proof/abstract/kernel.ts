import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import { verifyChannelClosureResult } from "../../closure/verify.js";
import { deriveLiveClosureAuthorityBinding } from
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
  assertDigest,
  assertIdentity,
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
    requests, [evaluation.outcome]);
}

export function evaluateAbstractSingletonCandidate(
  input: AbstractProofKernelInput
): KernelEvaluation {
  const preparation = prepareAbstractDomain(input);
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
}>;

export type KernelEvaluation = Readonly<{
  readonly kind: "singleton_candidate";
  readonly input: AbstractProofKernelInput;
  readonly coordinates: readonly AbstractCoordinate[];
  readonly outcome: FiniteDecisionTrace;
}> | Readonly<{
  readonly kind: "result";
  readonly result: AbstractProofKernelResult;
}>;

type KernelPreparation = PreparedKernel | Readonly<{
  readonly kind: "result";
  readonly result: AbstractProofKernelResult;
}>;

function prepareAbstractDomain(input: AbstractProofKernelInput): KernelPreparation {
  const invalid = validateKernelInput(input);
  if (invalid !== null) return preparedResult(unsupported(input, invalid));
  const fixture = normalizeFiniteFixture(input.fixture);
  const sensitivityCount = new Set(fixture.coordinates.map(({ sensitivity_id }) =>
    sensitivity_id)).size;
  if (input.closures.length > input.limits.max_channels ||
      input.coordinates.length > input.limits.max_coordinates ||
      sensitivityCount > input.limits.max_sensitivities) {
    return preparedResult(unsupported(input, "declared abstract domain limit exceeded"));
  }
  let coordinates: readonly AbstractCoordinate[];
  try {
    coordinates = normalizeAbstractCoordinates(input.coordinates);
  } catch (error) {
    return preparedResult(unsupported(input, messageOf(error)));
  }
  const normalizedInput = Object.freeze({ ...input, fixture, coordinates });
  const conflicts = coordinates.filter(isConflictCoordinate);
  if (conflicts.length > 0) {
    return preparedResult(conflict(normalizedInput,
      conflicts.map(({ coordinate_id }) => coordinate_id),
      "abstract proposition conflict"));
  }
  const closureRequests = validateClosures(input);
  if (closureRequests.length > 0) {
    return preparedResult(open(normalizedInput,
      "unresolved or invalid channel closure", closureRequests, []));
  }
  const transferMismatch = validateFixtureAbstractCoverage(fixture, coordinates);
  if (transferMismatch !== null) {
    return preparedResult(unsupported(normalizedInput, transferMismatch));
  }
  const scopedEffects = collectScopedEffects(input);
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
      "unresolved channel or abstract domain", preOperatorRequests, []));
  }
  const remainingEffects = Object.freeze(scopedEffects.map(({ effect }) => effect));
  return Object.freeze({
    kind: "prepared" as const,
    input: effectiveInput,
    coordinates: joined.coordinates,
    remaining_effects: remainingEffects,
    fixture,
    transfer_digest: digestRecallFieldIdentity({
      authority_digest: abstractResultIdentity(effectiveInput).authority_digest,
      fixture_digest: digestFiniteFixture(fixture),
      concrete_operator_id: input.concrete_operator.operator_id,
      abstract_operator_id: input.operator.operator_id,
      manifest_digest: digestFiniteManifest(fixture)
    })
  });
}

function evaluatePreparedKernel(prepared: PreparedKernel): KernelEvaluation {
  const { input, coordinates, remaining_effects: remainingEffects } = prepared;
  let evaluation: AbstractOperatorEvaluation;
  try {
    evaluation = evaluateDeterministically(input.operator, coordinates,
      remainingEffects, input.k_max, prepared.transfer_digest);
    validateOperatorEvaluation(evaluation);
  } catch (error) {
    return resultEvaluation(unsupported(input, messageOf(error)));
  }
  if (evaluation.status === "conflict") {
    return resultEvaluation(conflict(input, [], evaluation.reason));
  }
  if (evaluation.status === "unsupported") {
    return resultEvaluation(unsupported(input, evaluation.reason));
  }
  const handled = new Set(evaluation.handled_sensitivity_ids);
  const manifest = new Set(prepared.fixture.coordinates.map(({ sensitivity_id }) =>
    sensitivity_id));
  if ([...handled].some((sensitivityId) => !manifest.has(sensitivityId))) {
    return resultEvaluation(unsupported(input,
      "abstract operator handled sensitivities outside the finite manifest"));
  }
  const missingManifest = prepared.fixture.coordinates.filter(({ sensitivity_id }) =>
    !handled.has(sensitivity_id));
  if (missingManifest.length > 0) {
    return resultEvaluation(open(input,
      "abstract operator did not handle complete sensitivity manifest",
      requestsForManifest(missingManifest, coordinates), []));
  }
  let outcomes: readonly FiniteDecisionTrace[];
  try {
    outcomes = normalizeOutcomes(evaluation.outcomes, input.k_max);
  } catch (error) {
    return resultEvaluation(unsupported(input, messageOf(error)));
  }
  if (outcomes.length === 0) {
    return resultEvaluation(unsupported(input, "abstract operator returned no outcome"));
  }
  if (outcomes.length === 1) {
    return Object.freeze({
      kind: "singleton_candidate" as const,
      input,
      coordinates,
      outcome: outcomes[0]!
    });
  }
  const requests = mergeRequests(coordinates.filter(isDecisionOpenCoordinate)
    .map((coordinate) => requestFor(coordinate, "multiple abstract outcomes")));
  if (requests.length === 0) {
    return resultEvaluation(unsupported(input,
      "multiple outcomes lack a decision-changing coordinate"));
  }
  return Object.freeze({ kind: "result" as const,
    result: open(input, "multiple abstract outcomes", requests, outcomes) });
}

function preparedResult(result: AbstractProofKernelResult): KernelPreparation {
  return Object.freeze({ kind: "result", result });
}

function resultEvaluation(result: AbstractProofKernelResult): KernelEvaluation {
  return Object.freeze({ kind: "result", result });
}

function validateKernelInput(input: AbstractProofKernelInput): string | null {
  try {
    assertExactKeys(input, [
      "live_authority", "fixture", "concrete_operator", "k_max", "closures",
      "coordinates", "limits", "operator"
    ], "abstract kernel input");
    assertExactKeys(input.limits, [
      "max_channels", "max_coordinates", "max_sensitivities"
    ], "abstract kernel limits");
    if (!Array.isArray(input.closures) || !Array.isArray(input.coordinates)) {
      return "abstract kernel closures and coordinates must be arrays";
    }
    const live = deriveLiveClosureAuthorityBinding(input.live_authority);
    const fixture = normalizeFiniteFixture(input.fixture);
    if (fixture.snapshot_digest !== live.snapshot_digest) {
      return "abstract fixture snapshot is outside live authority";
    }
    if (input.k_max !== fixture.k_max) {
      return "abstract K_max does not match finite fixture";
    }
    assertExactKeys(input.concrete_operator, ["operator_id", "decide"],
      "abstract concrete operator");
    assertIdentity(input.concrete_operator.operator_id, "abstract concrete operator id");
    assertIdentity(input.operator.operator_id, "abstract operator id");
    if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(input.operator.operator_id) ||
        input.operator.operator_id.includes("decide_q") ||
        input.operator.operator_id.includes("sealchecker_v1")) {
      return "abstract fixture operator uses a reserved final operator name";
    }
    if (!Number.isSafeInteger(input.k_max) || input.k_max < 0 ||
        !Number.isSafeInteger(input.limits.max_channels) ||
        !Number.isSafeInteger(input.limits.max_coordinates) ||
        !Number.isSafeInteger(input.limits.max_sensitivities) ||
        input.limits.max_channels < 1 || input.limits.max_coordinates < 1 ||
        input.limits.max_sensitivities < 1) {
      return "abstract kernel limits are invalid";
    }
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

function validateClosures(
  input: AbstractProofKernelInput
): readonly AbstractRefinementRequest[] {
  const requests: AbstractRefinementRequest[] = [];
  for (const closure of input.closures) {
    try {
      verifyChannelClosureResult(closure, input.live_authority);
    } catch {
      requests.push(channelRequest(safeChannelId(closure),
        "closure receipt digest mismatch"));
      continue;
    }
    if (closure.status === "uncertified") {
      requests.push(channelRequest(closure.channel_id, closure.reason));
    }
  }
  return mergeRequests(requests);
}

function validateFixtureAbstractCoverage(
  fixture: FiniteOracleFixture,
  coordinates: readonly AbstractCoordinate[]
): string | null {
  if (fixture.coordinates.length !== coordinates.length) {
    return "abstract coordinates do not exactly cover finite fixture manifest";
  }
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index]!;
    const row = fixture.coordinates[index]!;
    if (coordinate.coordinate_id !== row.coordinate_id ||
        coordinate.sensitivity_id !== row.sensitivity_id ||
        coordinate.owner_id !== row.owner_id ||
        coordinate.kind !== row.abstract_kind) {
      return "abstract coordinate does not match finite fixture manifest";
    }
  }
  return null;
}

function safeChannelId(value: unknown): string {
  if (typeof value === "object" && value !== null && "channel_id" in value &&
      typeof value.channel_id === "string" && value.channel_id.length > 0) {
    return value.channel_id;
  }
  return "invalid-channel";
}

function collectScopedEffects(
  input: AbstractProofKernelInput
): readonly ScopedRemainingEffect[] {
  return Object.freeze(input.closures.flatMap((closure) =>
    closure.remaining_effects.map((effect) => Object.freeze({
      owner_id: closure.channel_id,
      effect
    }))).sort((left, right) =>
      compareText(left.effect.sensitivity_id, right.effect.sensitivity_id) ||
      compareText(left.owner_id, right.owner_id) ||
      compareText(left.effect.effect_id, right.effect.effect_id)));
}

function evaluateDeterministically(
  operator: AbstractDecisionOperator,
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
  const first = operator.evaluate(input);
  const replay = operator.evaluate(input);
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

function assertExactKeys(value: object, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index])) throw new Error(`${field} has unknown or missing fields`);
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
  outcomes: readonly FiniteDecisionTrace[]
): Extract<AbstractProofKernelResult, { status: "OPEN" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input),
    status: "OPEN" as const,
    reason,
    requested_refinements: requests,
    possible_outcomes: outcomes
  });
}

function conflict(
  input: AbstractProofKernelInput,
  coordinateIds: readonly string[],
  reason: string
): Extract<AbstractProofKernelResult, { status: "CONFLICT" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input),
    status: "CONFLICT" as const,
    reason,
    conflict_coordinate_ids: Object.freeze([...coordinateIds].sort(compareText))
  });
}

function unsupported(
  input: AbstractProofKernelInput,
  reason: string
): Extract<AbstractProofKernelResult, { status: "UNSUPPORTED" }> {
  return sealAbstractRefusalResult({
    ...abstractResultIdentity(input),
    status: "UNSUPPORTED" as const,
    reason
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "abstract kernel input is invalid";
}
