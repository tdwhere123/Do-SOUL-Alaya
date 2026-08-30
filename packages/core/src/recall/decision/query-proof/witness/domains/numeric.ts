import { ShadowContractError } from "../../../prefix-capture/envelope.js";
import {
  isZeroInterval,
  intervalContradictory,
  intervalEqual,
  intervalJoin,
  intervalLeq,
  intervalMeet,
  parseFiniteInterval,
  type FiniteInterval
} from "../shared/bounds.js";
import { createTypedWitness, rejectPayload } from "../shared/create.js";
import { isKnownZeroEpistemic } from "../shared/epistemic.js";
import { joinWitness, meetWitness, refineWitness } from "../shared/kernel.js";
import { compareWitness, informationLeq } from "../shared/kernel-order.js";
import type { PayloadOps } from "../shared/kernel-ops.js";
import type {
  TypedWitness,
  WitnessCreateInput,
  WitnessEpistemic,
  WitnessInformationOrder
} from "../shared/types.js";

export type NumericIntervalPayload = FiniteInterval;
export type NumericIntervalWitness = TypedWitness<"numeric_interval", NumericIntervalPayload>;
export type NumericIntervalInput = WitnessCreateInput<NumericIntervalPayload>;

const NUMERIC_OPS: PayloadOps<NumericIntervalPayload> = Object.freeze({
  leq: intervalLeq,
  equal: intervalEqual,
  meet: intervalMeet,
  join: intervalJoin,
  contradictory: intervalContradictory
});

export function createNumericIntervalWitness(
  input: NumericIntervalInput
): NumericIntervalWitness {
  return createTypedWitness("numeric_interval", input, ["candidate_id"], numericPayload);
}

export function compareNumericInterval(
  left: NumericIntervalWitness,
  right: NumericIntervalWitness
): WitnessInformationOrder {
  return compareWitness(NUMERIC_OPS, left, right);
}

export function numericInformationLeq(
  wide: NumericIntervalWitness,
  narrow: NumericIntervalWitness
): boolean {
  return informationLeq(NUMERIC_OPS, wide, narrow);
}

export function refineNumericInterval(
  from: NumericIntervalWitness,
  to: NumericIntervalWitness
): NumericIntervalWitness {
  return refineWitness(NUMERIC_OPS, from, to);
}

export function meetNumericInterval(
  left: NumericIntervalWitness,
  right: NumericIntervalWitness
): NumericIntervalWitness {
  return meetWitness(NUMERIC_OPS, left, right);
}

export function joinNumericInterval(
  left: NumericIntervalWitness,
  right: NumericIntervalWitness
): NumericIntervalWitness {
  return joinWitness(NUMERIC_OPS, left, right);
}

function numericPayload(
  epistemic: WitnessEpistemic,
  payload: NumericIntervalPayload | null | undefined
): NumericIntervalPayload | null {
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (isKnownZeroEpistemic(epistemic)) return knownZeroPayload(payload);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact numeric interval requires bounds");
  }
  return parseFiniteInterval(payload.lower, payload.upper);
}

function knownZeroPayload(
  payload: NumericIntervalPayload | null | undefined
): NumericIntervalPayload | null {
  if (payload === null || payload === undefined) return null;
  const interval = parseFiniteInterval(payload.lower, payload.upper);
  if (!isZeroInterval(interval)) {
    throw new ShadowContractError("known_zero requires exact {0}");
  }
  return interval;
}
