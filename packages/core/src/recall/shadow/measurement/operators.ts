import { ShadowContractError } from "../envelope.js";
import { intervalEqual, intervalMeet, type FiniteInterval } from
  "../witness/shared/bounds.js";
import type { NumericIntervalWitness } from "../witness/index.js";

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
): FiniteInterval {
  const first = requireInterval(intervals);
  for (const interval of intervals) {
    if (!intervalEqual(first, interval)) {
      throw new ShadowContractError("identity_dedupe requires exact agreement");
    }
  }
  return first;
}

export function intersectIntervals(
  intervals: readonly FiniteInterval[]
): FiniteInterval | "conflict" {
  let current: FiniteInterval | "conflict" = requireInterval(intervals);
  for (const interval of intervals.slice(1)) {
    if (current === "conflict") return "conflict";
    current = intervalMeet(current, interval);
  }
  return current;
}

export function nestedInterval(
  intervals: readonly FiniteInterval[]
): FiniteInterval | "conflict" {
  return intersectIntervals(intervals);
}

export function provedLowerMaxInterval(
  intervals: readonly FiniteInterval[]
): { readonly lower: number; readonly upper: number } {
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  for (const interval of intervals) {
    lower = Math.max(lower, interval.lower);
    upper = Math.min(upper, interval.upper);
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    throw new ShadowContractError("proved_lower_max requires finite bounds");
  }
  if (lower > upper) {
    throw new ShadowContractError("proved_lower_max upper bound is unsound");
  }
  return { lower, upper };
}

function requireInterval(intervals: readonly FiniteInterval[]): FiniteInterval {
  const first = intervals[0];
  if (first === undefined) {
    throw new ShadowContractError("measurement collapse requires observations");
  }
  return first;
}
