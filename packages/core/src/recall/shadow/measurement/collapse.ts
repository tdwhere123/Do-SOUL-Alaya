import { freezeShadow, ShadowContractError } from "../envelope.js";
import type { FiniteInterval } from "../witness/shared/bounds.js";
import { unionProvenance } from "../witness/shared/provenance.js";
import {
  createNumericIntervalWitness,
  exactEpistemic,
  isKnownZeroEpistemic,
  type CorrelationState,
  type CorrelationWitness,
  type NumericIntervalWitness,
  type WitnessEpistemic
} from "../witness/index.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import {
  identityDedupeIntervals,
  intersectIntervals,
  nestedInterval,
  provedLowerMaxInterval,
  requireIntervals,
  type MeasurementIntervalResult
} from "./operators.js";

export type MeasurementCollapseInputV1 = Readonly<{
  readonly contract: MeasurementGroupContractV1;
  readonly observations: readonly NumericIntervalWitness[];
  readonly correlations?: readonly CorrelationWitness[];
}>;

export type MeasurementCollapseV1 =
  | Readonly<{
      readonly status: "collapsed";
      readonly contract: MeasurementGroupContractV1;
      readonly witness: NumericIntervalWitness;
    }>
  | Readonly<{
      readonly status: "unresolved";
      readonly reason: string;
      readonly observations: readonly NumericIntervalWitness[];
    }>
  | Readonly<{
      readonly status: "conflict";
      readonly witness: NumericIntervalWitness;
    }>;

type CollapsePass =
  | MeasurementCollapseV1
  | {
      readonly status: "ok";
      readonly observations: readonly NumericIntervalWitness[];
    };

type CoordinateDedupe =
  | {
      readonly status: "ok";
      readonly observations: readonly NumericIntervalWitness[];
    }
  | { readonly status: "conflict" }
  | { readonly status: "unresolved"; readonly reason: string };

export function collapseMeasurementGroup(
  input: MeasurementCollapseInputV1
): MeasurementCollapseV1 {
  if (input.contract.measurement_domain !== "numeric_interval" ||
    input.contract.combine_operator === "exact_state_only") {
    throw new ShadowContractError("numeric collapse requires a numeric measurement contract");
  }
  assertSameBinding(input.observations);
  const partitioned = partitionForCollapse(input.observations);
  if (partitioned.status !== "ok") return partitioned;
  const correlated = applyCorrelation(
    input.contract,
    partitioned.observations,
    input.correlations ?? []
  );
  if (correlated.status !== "ok") return correlated;
  return combine(input.contract, correlated.observations);
}

function partitionForCollapse(
  observations: readonly NumericIntervalWitness[]
): CollapsePass {
  if (observations.some((row) => row.epistemic.kind === "conflict")) {
    return conflictFrom(observations);
  }
  if (observations.some(isApplicableUnknown)) {
    return unresolved("applicable unknown observation blocks collapse", observations);
  }
  const exact = observations.filter((row) =>
    row.domain === "numeric_interval" && row.epistemic.kind === "exact"
  );
  if (exact.length === 0) {
    return unresolved("non-exact observation remains unresolved", observations);
  }
  return { status: "ok", observations: exact };
}

function isApplicableUnknown(observation: NumericIntervalWitness): boolean {
  const kind = observation.epistemic.kind;
  return kind === "unavailable" || kind === "not_observed" || kind === "negative";
}

function applyCorrelation(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  correlations: readonly CorrelationWitness[]
): CollapsePass {
  const unique = dedupeByCoordinate(observations);
  if (unique.status !== "ok") {
    return unique.status === "conflict"
      ? conflictFrom(observations)
      : unresolved(unique.reason, observations);
  }
  // identity_dedupe only drops duplicate coordinate_id rows. Distinct
  // coordinates of the same binding still combine via combine_operator.
  if (contract.correlation_policy === "identity_dedupe") {
    return { status: "ok", observations: unique.observations };
  }
  return requireDeclaredCorrelation(contract, unique.observations, correlations);
}

function requireDeclaredCorrelation(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  correlations: readonly CorrelationWitness[]
): CollapsePass {
  for (const [left, right] of distinctCoordinates(observations)) {
    const state = declaredCorrelation(left, right, correlations);
    if (state === undefined) {
      return unresolved("unknown correlation blocks collapse", observations);
    }
    if (state === "possibly_correlated" && contract.correlation_policy === "unknown_blocks") {
      return unresolved("unknown correlation blocks collapse", observations);
    }
  }
  return { status: "ok", observations };
}

function combine(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[]
): MeasurementCollapseV1 {
  const bounded = observations.filter((row) => row.payload !== null);
  if (bounded.length !== observations.length) {
    return combineNullExact(contract, observations, bounded);
  }
  return finishCombine(contract, observations, combineOperator(contract, observations));
}

function combineNullExact(
  _contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  bounded: readonly NumericIntervalWitness[]
): MeasurementCollapseV1 {
  if (bounded.length > 0) return conflictFrom(observations);
  return unresolved(
    "source-coordinate completeness does not authorize collapsed absence",
    observations
  );
}

function finishCombine(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  result: MeasurementIntervalResult
): MeasurementCollapseV1 {
  if (result.status === "unresolved") return unresolved(result.reason, observations);
  if (result.status === "conflict") return conflictFrom(observations);
  return freezeShadow({
    status: "collapsed" as const,
    contract,
    witness: assembleCollapsed(observations, result.interval, exactEpistemic())
  });
}

function combineOperator(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[]
): MeasurementIntervalResult {
  const intervals = requireIntervals(observations);
  if (contract.combine_operator === "identity_dedupe" ||
    contract.combine_operator === "exact_agreement") {
    return identityDedupeIntervals(intervals);
  }
  if (contract.combine_operator === "bound_intersection") {
    return intersectIntervals(intervals);
  }
  if (contract.combine_operator === "existential_proof") {
    return nestedInterval(intervals);
  }
  return collapseLowerMax(contract, intervals);
}

function collapseLowerMax(
  contract: MeasurementGroupContractV1,
  intervals: ReturnType<typeof requireIntervals>
): MeasurementIntervalResult {
  if (contract.upper_bound_rule !== "interval_upper") {
    return {
      status: "unresolved",
      reason: "proved_lower_max requires a declared upper-bound rule"
    };
  }
  return provedLowerMaxInterval(intervals);
}

function assembleCollapsed(
  observations: readonly NumericIntervalWitness[],
  payload: FiniteInterval,
  epistemic: WitnessEpistemic
): NumericIntervalWitness {
  const first = observations[0]!;
  return createNumericIntervalWitness({
    identity: collapsedIdentity(first),
    provenance: mergedProvenance(observations),
    epistemic,
    payload
  });
}

function assembleConflict(
  observations: readonly NumericIntervalWitness[]
): NumericIntervalWitness {
  const first = observations[0]!;
  return createNumericIntervalWitness({
    identity: collapsedIdentity(first),
    provenance: mergedProvenance(observations),
    epistemic: { kind: "conflict" },
    payload: null
  });
}

function collapsedIdentity(first: NumericIntervalWitness): NumericIntervalWitness["identity"] {
  return {
    coordinate_id: `measure:${first.identity.proposition_id ?? first.identity.coordinate_id}`,
    query_id: first.identity.query_id,
    snapshot_digest: first.identity.snapshot_digest,
    candidate_id: first.identity.candidate_id,
    proposition_id: first.identity.proposition_id
  };
}

function mergedProvenance(observations: readonly NumericIntervalWitness[]) {
  let provenance = observations[0]!.provenance;
  for (const observation of observations.slice(1)) {
    provenance = unionProvenance(provenance, observation.provenance);
  }
  return canonicalProvenance(provenance);
}

function canonicalProvenance(
  provenance: NumericIntervalWitness["provenance"]
): NumericIntervalWitness["provenance"] {
  return Object.freeze([...provenance].sort((left, right) =>
    compareText(left.source_id, right.source_id) ||
    compareText(left.producer, right.producer)));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertSameBinding(observations: readonly NumericIntervalWitness[]): void {
  const first = observations[0];
  if (first === undefined) return;
  for (const observation of observations) {
    if (observation.identity.query_id !== first.identity.query_id ||
      observation.identity.snapshot_digest !== first.identity.snapshot_digest ||
      observation.identity.candidate_id !== first.identity.candidate_id ||
      observation.identity.proposition_id !== first.identity.proposition_id) {
      throw new ShadowContractError("measurement collapse requires the same candidate/proposition binding");
    }
  }
}

function dedupeByCoordinate(
  observations: readonly NumericIntervalWitness[]
): CoordinateDedupe {
  const seen = new Map<string, NumericIntervalWitness>();
  for (const observation of observations) {
    const key = observation.identity.coordinate_id;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, observation);
      continue;
    }
    const merged = mergeDuplicateCoordinate(previous, observation);
    if (merged === "conflict") return { status: "conflict" };
    if (typeof merged === "string") return { status: "unresolved", reason: merged };
    seen.set(key, merged);
  }
  return { status: "ok", observations: Object.freeze([...seen.values()]) };
}

function mergeDuplicateCoordinate(
  previous: NumericIntervalWitness,
  observation: NumericIntervalWitness
): NumericIntervalWitness | "conflict" | "completeness receipt mismatch" {
  if (!samePayload(previous.payload, observation.payload)) return "conflict";
  const previousKnown = isKnownZeroEpistemic(previous.epistemic);
  const nextKnown = isKnownZeroEpistemic(observation.epistemic);
  if (previousKnown && nextKnown &&
    previous.epistemic.completeness.receipt_digest !==
      observation.epistemic.completeness.receipt_digest) {
    return "completeness receipt mismatch";
  }
  const selected = nextKnown && !previousKnown ? observation : previous;
  return createNumericIntervalWitness({
    identity: selected.identity,
    provenance: canonicalProvenance(
      unionProvenance(previous.provenance, observation.provenance)
    ),
    epistemic: selected.epistemic,
    payload: selected.payload
  });
}

function samePayload(
  left: NumericIntervalWitness["payload"],
  right: NumericIntervalWitness["payload"]
): boolean {
  if (left === null || right === null) return left === right;
  return left.lower === right.lower && left.upper === right.upper;
}

function distinctCoordinates(
  observations: readonly NumericIntervalWitness[]
): readonly [NumericIntervalWitness, NumericIntervalWitness][] {
  const pairs: [NumericIntervalWitness, NumericIntervalWitness][] = [];
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      pairs.push([observations[i]!, observations[j]!]);
    }
  }
  return pairs;
}

function declaredCorrelation(
  left: NumericIntervalWitness,
  right: NumericIntervalWitness,
  correlations: readonly CorrelationWitness[]
): CorrelationState | undefined {
  for (const witness of correlations) {
    const payload = witness.payload;
    if (payload === null || witness.epistemic.kind !== "exact") continue;
    const ids = new Set([payload.left_id, payload.right_id]);
    if (ids.has(left.identity.coordinate_id) && ids.has(right.identity.coordinate_id)) {
      return payload.state;
    }
  }
  return undefined;
}

function conflictFrom(
  observations: readonly NumericIntervalWitness[]
): Extract<MeasurementCollapseV1, { status: "conflict" }> {
  return freezeShadow({
    status: "conflict" as const,
    witness: assembleConflict(observations)
  });
}

function unresolved(
  reason: string,
  observations: readonly NumericIntervalWitness[]
): Extract<MeasurementCollapseV1, { status: "unresolved" }> {
  return freezeShadow({
    status: "unresolved" as const,
    reason,
    observations: Object.freeze([...observations])
  });
}
