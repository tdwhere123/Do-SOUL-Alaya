import { clamp01 } from "../../../shared/clamp.js";

/** Preserve the difference between observed zero and an unavailable score. */
export function readObservedUnitScore(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : clamp01(value);
}
