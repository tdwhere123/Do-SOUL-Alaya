import { clamp01 } from "../../../shared/clamp.js";
import type {
  ComponentSourceObservation,
  ComponentSourceState
} from "./selection-boundary-component-ledger-types.js";

/** Classify a raw numeric source before `?? 0` / clamp collapses states. */
export function observeNumericSource(
  eligible: boolean,
  raw: number | undefined
): ComponentSourceObservation {
  if (!eligible) {
    return Object.freeze({ state: "ineligible", raw: null, unit_interval: null });
  }
  if (raw === undefined) {
    return Object.freeze({ state: "absent", raw: null, unit_interval: null });
  }
  if (!Number.isFinite(raw)) {
    return Object.freeze({ state: "invalid", raw: null, unit_interval: null });
  }
  if (raw < 0) {
    return Object.freeze({ state: "invalid", raw, unit_interval: null });
  }
  const state: ComponentSourceState = raw === 0
    ? "observed_zero"
    : "observed_positive";
  return Object.freeze({
    state,
    raw,
    unit_interval: clamp01(raw)
  });
}

export function isObservedSource(
  observation: ComponentSourceObservation
): boolean {
  return observation.state === "observed_zero" ||
    observation.state === "observed_positive";
}
