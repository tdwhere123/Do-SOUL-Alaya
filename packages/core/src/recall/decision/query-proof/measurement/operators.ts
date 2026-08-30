import { ShadowContractError } from "../../prefix-capture/envelope.js";
import {
  intervalEqual,
  intervalMeet,
  type FiniteInterval
} from "../witness/shared/bounds.js";
import type { NumericIntervalWitness } from "../witness/index.js";

export type MeasurementIntervalResult =
  | Readonly<{
      readonly status: "collapsed";
      readonly interval: FiniteInterval;
    }>
  | Readonly<{
      readonly status: "conflict";
    }>
  | Readonly<{
      readonly status: "unresolved";
      readonly reason: string;
    }>;

export function requireIntervals(
  observations: readonly NumericIntervalWitness[]
): readonly FiniteInterval[] {
  return observations.map((observation) => {
    if (observation.payload === null) {
      throw new ShadowContractError("exact numeric interval requires bounds");
    }
    return observation.payload;
  });
}

export function identityDedupeIntervals(
  intervals: readonly FiniteInterval[]
): MeasurementIntervalResult {
  const first = requireInterval(intervals);
  for (const interval of intervals) {
    if (!intervalEqual(first, interval)) {
      return unresolved("identity_dedupe requires exact agreement");
    }
  }
  return collapsed(first);
}

export function intersectIntervals(
  intervals: readonly FiniteInterval[]
): MeasurementIntervalResult {
  let current: FiniteInterval | "conflict" = requireInterval(intervals);
  for (const interval of intervals.slice(1)) {
    if (current === "conflict") return { status: "conflict" };
    current = intervalMeet(current, interval);
  }
  return current === "conflict" ? { status: "conflict" } : collapsed(current);
}

export function nestedInterval(
  intervals: readonly FiniteInterval[]
): MeasurementIntervalResult {
  const meet = intersectIntervals(intervals);
  if (meet.status !== "collapsed") return meet;
  // Meet of non-nested overlap is a new interval, not an observed nested
  // strengthening, so existential_proof cannot reuse bound_intersection.
  if (intervals.some((interval) => intervalEqual(interval, meet.interval))) {
    return meet;
  }
  return unresolved("existential_proof requires nested intervals");
}

export function provedLowerMaxInterval(
  intervals: readonly FiniteInterval[]
): MeasurementIntervalResult {
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    lower = Math.max(lower, interval.lower);
    upper = Math.max(upper, interval.upper);
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return unresolved("proved_lower_max requires finite bounds");
  }
  if (lower > upper) return { status: "conflict" };
  return collapsed(Object.freeze({ lower, upper }));
}

function collapsed(interval: FiniteInterval): MeasurementIntervalResult {
  return { status: "collapsed", interval };
}

function unresolved(reason: string): MeasurementIntervalResult {
  return { status: "unresolved", reason };
}

function requireInterval(intervals: readonly FiniteInterval[]): FiniteInterval {
  const first = intervals[0];
  if (first === undefined) {
    throw new ShadowContractError("measurement collapse requires observations");
  }
  return first;
}
