import type { ObserverActionResult } from "../conditional-field/observers/observe.js";
import type { ObservationMeasurement } from "../conditional-field/observers/measure-stored.js";
import type { FieldObservationEffect } from "../conditional-field/engine/field-engine.js";

export function measurementEffectsFor(result: ObserverActionResult): readonly FieldObservationEffect[] {
  const rows = result.measurements ?? [];
  if (rows.length === 0) {
    if (result.page.outcome.status === "interrupted") return []; // Budget interrupt is not a missing profile.
    return [absentEffect(`${result.page.cursor.region_id}:missing-measurement`)];
  }
  return rows.map(effectFromMeasurement);
}

function effectFromMeasurement(row: ObservationMeasurement): FieldObservationEffect {
  return {
    observation_id: row.observation_id,
    raw_measurement: row.raw,
    projected_cap: row.cap,
    ...(row.raw.status === "measured" ? {} : { missing_measurement: true as const })
  };
}

function absentEffect(observationId: string): FieldObservationEffect {
  return {
    observation_id: observationId,
    raw_measurement: { status: "missing" },
    projected_cap: { status: "inapplicable" },
    missing_measurement: true
  };
}

export function measurementIsMissing(effects: readonly FieldObservationEffect[]): boolean {
  return effects.some((effect) =>
    effect.missing_measurement === true
    || (effect.raw_measurement !== undefined && effect.raw_measurement.status !== "measured")
  );
}
