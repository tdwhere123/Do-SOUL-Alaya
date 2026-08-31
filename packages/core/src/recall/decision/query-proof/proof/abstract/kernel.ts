import { compareText } from "../../../../../shared/compare-text.js";
import { digestRecallFieldIdentity } from
  "../../../../field/field-identity.js";
import { verifyChannelClosureResult } from "../../closure/verify.js";
import {
  decisionTraceSortKey,
  normalizeDecisionTrace,
  type FiniteDecisionTrace
} from "../oracle/contract.js";
import {
  readFiniteTransferAuthority,
  validateFiniteTransferAbstractCoverage,
  verifyFiniteTransferParticipants,
  type FiniteTransferAuthorityState
} from "../oracle/transfer-authority.js";
import {
  abstractResultIdentity,
  assertDigest,
  assertIdentity,
  normalizeAbstractCoordinates,
  sealAbstractResult,
  type AbstractCoordinate,
  type AbstractDecisionOperator,
  type AbstractOperatorEvaluation,
  type AbstractProofKernelInput,
  type AbstractProofKernelResult,
  type AbstractRefinementRequest
} from "./contract.js";
import {
  joinChannelRemainingEffects,
  type ScopedRemainingEffect
} from "./domain-join.js";

export function evaluateAbstractProofKernel(
  input: AbstractProofKernelInput
): AbstractProofKernelResult {
  const preparation = prepareAbstractDomain(input);
  return preparation.kind === "result"
    ? preparation.result
    : evaluatePreparedKernel(preparation);
}

type PreparedKernel = Readonly<{
  readonly kind: "prepared";
  readonly input: AbstractProofKernelInput;
  readonly coordinates: readonly AbstractCoordinate[];
  readonly remaining_effects:
    AbstractProofKernelInput["closures"][number]["remaining_effects"];
  readonly transfer: FiniteTransferAuthorityState;
}>;

type KernelPreparation = PreparedKernel | Readonly<{
  readonly kind: "result";
  readonly result: AbstractProofKernelResult;
}>;

function prepareAbstractDomain(input: AbstractProofKernelInput): KernelPreparation {
  const invalid = validateKernelInput(input);
  if (invalid !== null) return preparedResult(unsupported(input, invalid));
  const transfer = readFiniteTransferAuthority(input.transfer_authority);
  const sensitivityCount = new Set(transfer.manifest.map(({ sensitivity_id }) =>
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
  const normalizedInput = Object.freeze({ ...input, coordinates });
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
  const transferMismatch = validateFiniteTransferAbstractCoverage({
    state: transfer,
    coordinates,
    closure_sensitivities: input.closures.flatMap((closure) =>
      closure.sensitivity_manifest)
  });
  if (transferMismatch !== null) {
    return preparedResult(unsupported(normalizedInput, transferMismatch));
  }
  const scopedEffects = collectScopedEffects(input);
  const joined = joinChannelRemainingEffects(coordinates, scopedEffects);
  const effectiveInput = Object.freeze({ ...input, coordinates: joined.coordinates });
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
    transfer
  });
}

function evaluatePreparedKernel(prepared: PreparedKernel): AbstractProofKernelResult {
  const { input, coordinates, remaining_effects: remainingEffects, transfer } = prepared;
  let evaluation: AbstractOperatorEvaluation;
  try {
    evaluation = evaluateDeterministically(input.operator, coordinates,
      remainingEffects, input.k_max, transfer.transfer_digest);
    validateOperatorEvaluation(evaluation);
  } catch (error) {
    return unsupported(input, messageOf(error));
  }
  if (evaluation.status === "conflict") {
    return conflict(input, [], evaluation.reason);
  }
  if (evaluation.status === "unsupported") {
    return unsupported(input, evaluation.reason);
  }
  const handled = new Set(evaluation.handled_sensitivity_ids);
  const missingManifest = transfer.manifest.filter(({ sensitivity_id }) =>
    !handled.has(sensitivity_id));
  if (missingManifest.length > 0) {
    return open(input, "abstract operator did not handle complete sensitivity manifest",
      requestsForManifest(missingManifest, coordinates), []);
  }
  let outcomes: readonly FiniteDecisionTrace[];
  try {
    outcomes = normalizeOutcomes(evaluation.outcomes, input.k_max);
  } catch (error) {
    return unsupported(input, messageOf(error));
  }
  if (outcomes.length === 0) {
    return unsupported(input, "abstract operator returned no outcome");
  }
  if (outcomes.length === 1) {
    return sealAbstractResult({
      ...abstractResultIdentity(input),
      status: "PROVED_SINGLETON" as const,
      outcome: outcomes[0]!
    });
  }
  const requests = mergeRequests(coordinates.filter(isDecisionOpenCoordinate)
    .map((coordinate) => requestFor(coordinate, "multiple abstract outcomes")));
  if (requests.length === 0) {
    return unsupported(input,
      "multiple outcomes lack a decision-changing coordinate");
  }
  return open(input, "multiple abstract outcomes", requests, outcomes);
}

function preparedResult(result: AbstractProofKernelResult): KernelPreparation {
  return Object.freeze({ kind: "result", result });
}

function validateKernelInput(input: AbstractProofKernelInput): string | null {
  try {
    assertExactKeys(input, [
      "query_digest", "snapshot_digest", "principal_digest", "k_max", "closures",
      "coordinates", "limits", "operator", "transfer_authority"
    ], "abstract kernel input");
    assertExactKeys(input.limits, [
      "max_channels", "max_coordinates", "max_sensitivities"
    ], "abstract kernel limits");
    if (!Array.isArray(input.closures) || !Array.isArray(input.coordinates)) {
      return "abstract kernel closures and coordinates must be arrays";
    }
    assertDigest(input.query_digest, "abstract query");
    assertDigest(input.snapshot_digest, "abstract snapshot");
    assertDigest(input.principal_digest, "abstract principal");
    assertIdentity(input.operator.operator_id, "abstract operator id");
    if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(input.operator.operator_id) ||
        input.operator.operator_id.includes("decide_q") ||
        input.operator.operator_id.includes("sealchecker_v1")) {
      return "abstract fixture operator uses a reserved final operator name";
    }
    const transfer = verifyFiniteTransferParticipants({
      authority: input.transfer_authority,
      abstract_operator: input.operator
    });
    if (transfer.query_digest !== input.query_digest ||
        transfer.fixture.snapshot_digest !== input.snapshot_digest ||
        transfer.principal_digest !== input.principal_digest) {
      return "abstract transfer authority binding mismatch";
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
      verifyChannelClosureResult(closure);
    } catch {
      requests.push(channelRequest(safeChannelId(closure),
        "closure receipt digest mismatch"));
      continue;
    }
    if (closure.query_digest !== input.query_digest ||
        closure.snapshot_digest !== input.snapshot_digest ||
        closure.principal_digest !== input.principal_digest) {
      requests.push(channelRequest(closure.channel_id, "closure authority binding mismatch"));
      continue;
    }
    if (closure.status === "uncertified") {
      requests.push(channelRequest(closure.channel_id, closure.reason));
    }
  }
  return mergeRequests(requests);
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
  transferDigest: FiniteTransferAuthorityState["transfer_digest"]
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

function isConflictCoordinate(coordinate: AbstractCoordinate): boolean {
  return coordinate.kind === "four_valued_proposition" &&
    coordinate.possible_values.includes("both");
}

function isStrictlyOpenCoordinate(coordinate: AbstractCoordinate): boolean {
  return (
    (coordinate.kind === "identity_tie" && coordinate.universe === "open") ||
    (coordinate.kind === "correlation" &&
      coordinate.possible_relations.includes("unknown")) ||
    (coordinate.kind === "semantic_feasibility" &&
      coordinate.possible_states.includes("unresolved")) ||
    (coordinate.kind === "numeric_interval" && coordinate.role === "extremum" &&
      coordinate.overlaps_decision_boundary) ||
    (coordinate.kind === "four_valued_proposition" &&
      coordinate.possible_values.includes("unknown"))
  );
}

function isDecisionOpenCoordinate(coordinate: AbstractCoordinate): boolean {
  switch (coordinate.kind) {
    case "membership":
    case "semantic_feasibility":
      return coordinate.possible_states.length > 1;
    case "numeric_interval":
      return coordinate.lower < coordinate.upper;
    case "finite_values":
    case "four_valued_proposition":
      return coordinate.possible_values.length > 1;
    case "binding":
      return coordinate.possible_bindings.length > 1;
    case "temporal_interval":
      return coordinate.minimum_epoch_ms < coordinate.maximum_epoch_ms;
    case "correlation":
      return coordinate.possible_relations.length > 1;
    case "identity_tie":
      return coordinate.universe === "open" ||
        coordinate.possible_winner_digests.length > 1;
  }
}

function strictOpenReason(coordinate: AbstractCoordinate): string {
  switch (coordinate.kind) {
    case "identity_tie": return "open identity tail";
    case "correlation": return "unknown correlation";
    case "semantic_feasibility": return "unresolved semantic feasibility";
    case "numeric_interval": return "overlapping extremum interval";
    default: return "unknown proposition state";
  }
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
  return sealAbstractResult({
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
  return sealAbstractResult({
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
  return sealAbstractResult({
    ...abstractResultIdentity(input),
    status: "UNSUPPORTED" as const,
    reason
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "abstract kernel input is invalid";
}
