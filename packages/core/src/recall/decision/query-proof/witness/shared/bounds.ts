import { ShadowContractError } from "../../../contract-primitives.js";

export type FiniteInterval = Readonly<{
  readonly lower: number;
  readonly upper: number;
}>;

export type IntervalParseOptions = Readonly<{
  readonly integer?: boolean;
  readonly nonnegative?: boolean;
}>;

export function parseFiniteInterval(
  lower: unknown,
  upper: unknown,
  options: IntervalParseOptions = {}
): FiniteInterval {
  const parsedLower = parseBound(lower, "lower", options);
  const parsedUpper = parseBound(upper, "upper", options);
  if (parsedLower > parsedUpper) {
    throw new ShadowContractError("inverted bounds");
  }
  return Object.freeze({ lower: parsedLower, upper: parsedUpper });
}

export function intervalLeq(wide: FiniteInterval, narrow: FiniteInterval): boolean {
  return narrow.lower >= wide.lower && narrow.upper <= wide.upper;
}

export function intervalEqual(left: FiniteInterval, right: FiniteInterval): boolean {
  return left.lower === right.lower && left.upper === right.upper;
}

export function intervalMeet(
  left: FiniteInterval,
  right: FiniteInterval
): FiniteInterval | "conflict" {
  const lower = Math.max(left.lower, right.lower);
  const upper = Math.min(left.upper, right.upper);
  if (lower > upper) return "conflict";
  return Object.freeze({ lower, upper });
}

export function intervalJoin(left: FiniteInterval, right: FiniteInterval): FiniteInterval {
  return Object.freeze({
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper)
  });
}

export function intervalContradictory(
  left: FiniteInterval,
  right: FiniteInterval
): boolean {
  return Math.max(left.lower, right.lower) > Math.min(left.upper, right.upper);
}

export function isZeroInterval(interval: FiniteInterval): boolean {
  return interval.lower === 0 && interval.upper === 0;
}

function parseBound(
  value: unknown,
  label: string,
  options: IntervalParseOptions
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShadowContractError(`${label} must be finite`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new ShadowContractError(`${label} must be an integer`);
  }
  if (options.nonnegative === true && value < 0) {
    throw new ShadowContractError(`${label} must be nonnegative`);
  }
  return value;
}
