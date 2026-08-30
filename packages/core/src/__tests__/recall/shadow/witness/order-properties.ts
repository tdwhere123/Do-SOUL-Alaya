import { expect } from "vitest";
import type { WitnessInformationOrder } from "../../../../recall/shadow/witness/index.js";

export function assertPoset<T>(
  samples: readonly T[],
  leq: (wide: T, narrow: T) => boolean
): void {
  for (const sample of samples) {
    expect(leq(sample, sample)).toBe(true);
  }
  for (const left of samples) {
    for (const right of samples) {
      if (leq(left, right) && leq(right, left)) {
        expect(leq(left, left)).toBe(true);
        expect(sameInformation(left, right, leq)).toBe(true);
      }
    }
  }
  for (const first of samples) {
    for (const second of samples) {
      for (const third of samples) {
        if (leq(first, second) && leq(second, third)) {
          expect(leq(first, third)).toBe(true);
        }
      }
    }
  }
}

export function assertMonotoneRefinement<T>(
  wide: T,
  narrow: T,
  leq: (wide: T, narrow: T) => boolean,
  refine: (from: T, to: T) => T
): T {
  expect(leq(wide, narrow)).toBe(true);
  const refined = refine(wide, narrow);
  expect(leq(wide, refined)).toBe(true);
  expect(leq(refined, narrow)).toBe(true);
  expect(leq(narrow, refined)).toBe(true);
  return refined;
}

export function sameInformation<T>(
  left: T,
  right: T,
  leq: (wide: T, narrow: T) => boolean
): boolean {
  return leq(left, right) && leq(right, left);
}

export function expectOrder(
  actual: WitnessInformationOrder,
  expected: WitnessInformationOrder
): void {
  expect(actual).toBe(expected);
}
