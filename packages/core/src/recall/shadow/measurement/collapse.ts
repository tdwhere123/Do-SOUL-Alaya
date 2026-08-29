import { freezeShadow, ShadowContractError } from "../envelope.js";
import { unionProvenance } from "../witness/shared/provenance.js";
import {
  createNumericIntervalWitness,
  type CorrelationState,
  type CorrelationWitness,
  type NumericIntervalWitness
} from "../witness/index.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import {
  identityDedupeIntervals,
  intersectIntervals,
  nestedInterval,
  provedLowerMaxInterval,
  requireIntervals
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

export function collapseMeasurementGroup(
  input: MeasurementCollapseInputV1
): MeasurementCollapseV1 {
  assertSameBinding(input.observations);
  const exact = input.observations.filter((row) =>
    row.domain === "numeric_interval" && row.epistemic.kind === "exact" && row.payload !== null
  );
  if (exact.length === 0) {
    return unresolved("non-exact observation remains unresolved", input.observations);
  }
  const deduped = applyCorrelation(input.contract, exact, input.correlations ?? []);
  if (deduped.status === "unresolved") return deduped;
  return combine(input.contract, deduped.observations);
}

function applyCorrelation(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  correlations: readonly CorrelationWitness[]
): Extract<MeasurementCollapseV1, { status: "unresolved" }> | {
  readonly status: "ok";
  readonly observations: readonly NumericIntervalWitness[];
} {
  const unique = dedupeByCoordinate(observations);
  if (contract.correlation_policy === "identity_dedupe") {
    return { status: "ok", observations: unique };
  }
  const pairs = distinctCoordinates(unique);
  for (const [left, right] of pairs) {
    const state = declaredCorrelation(left, right, correlations);
    if (state === undefined && contract.correlation_policy !== "identity_dedupe") {
      return unresolved("unknown correlation blocks collapse", unique);
    }
    if (state === "possibly_correlated" && contract.correlation_policy === "unknown_blocks") {
      return unresolved("unknown correlation blocks collapse", unique);
    }
  }
  return { status: "ok", observations: unique };
}

function combine(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[]
): MeasurementCollapseV1 {
  try {
    const witness = combineOperator(contract, observations);
    if (witness.epistemic.kind === "conflict") {
      return freezeShadow({ status: "conflict" as const, witness });
    }
    return freezeShadow({ status: "collapsed" as const, contract, witness });
  } catch (error) {
    if (error instanceof ShadowContractError && /nested|agreement|exact comparator/u.test(error.message)) {
      return unresolved(error.message, observations);
    }
    throw error;
  }
}

function combineOperator(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[]
): NumericIntervalWitness {
  const intervals = requireIntervals(observations);
  if (contract.combine_operator === "identity_dedupe" ||
    contract.combine_operator === "exact_agreement") {
    return assembleCollapsed(observations, identityDedupeIntervals(intervals));
  }
  if (contract.combine_operator === "bound_intersection" ||
    contract.combine_operator === "existential_proof") {
    const meet = contract.combine_operator === "existential_proof"
      ? nestedInterval(intervals)
      : intersectIntervals(intervals);
    if (meet === "conflict") {
      return assembleConflict(observations);
    }
    return assembleCollapsed(observations, meet);
  }
  return collapseLowerMax(contract, observations, intervals);
}

function collapseLowerMax(
  contract: MeasurementGroupContractV1,
  observations: readonly NumericIntervalWitness[],
  intervals: ReturnType<typeof requireIntervals>
): NumericIntervalWitness {
  if (contract.upper_bound_rule !== "interval_upper") {
    throw new ShadowContractError("proved_lower_max cannot be an exact comparator without an upper-bound rule");
  }
  return assembleCollapsed(observations, provedLowerMaxInterval(intervals));
}

function assembleCollapsed(
  observations: readonly NumericIntervalWitness[],
  payload: { readonly lower: number; readonly upper: number }
): NumericIntervalWitness {
  const first = observations[0]!;
  return createNumericIntervalWitness({
    identity: collapsedIdentity(first),
    provenance: mergedProvenance(observations),
    epistemic: { kind: "exact" },
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
  return provenance;
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
): readonly NumericIntervalWitness[] {
  const seen = new Map<string, NumericIntervalWitness>();
  for (const observation of observations) {
    const key = observation.identity.coordinate_id;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, observation);
      continue;
    }
    if (previous.payload?.lower !== observation.payload?.lower ||
      previous.payload?.upper !== observation.payload?.upper) {
      throw new ShadowContractError("duplicate coordinate with conflicting exact values");
    }
  }
  return Object.freeze([...seen.values()]);
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
