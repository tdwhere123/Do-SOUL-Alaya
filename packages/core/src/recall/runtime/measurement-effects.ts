import type { AssociationCapContract, ProjectedCap, QueryInterpretation } from "@do-soul/alaya-protocol";
import type { ObserverActionResult } from "../conditional-field/observers/observe.js";
import type { ObservationMeasurement } from "../conditional-field/observers/measure-stored.js";
import type { FieldObservationEffect } from "../conditional-field/engine/field-engine.js";
import { capContractId } from "../conditional-field/cap-contract.js";
import { seedActivationsForObservation } from "../conditional-field/engine/path-composition.js";
import type { BindingContextStore } from "../conditional-field/engine/binding-environment.js";

export function measurementEffectsFor(result: ObserverActionResult, interpretation?: QueryInterpretation,
  asOf = "", prior: Iterable<ObservationMeasurement> = [], bindingContexts?: BindingContextStore): readonly FieldObservationEffect[] {
  const rows = result.measurements ?? [];
  if (rows.length === 0) {
    if (result.page.outcome.status === "interrupted") return []; // Budget interrupt is not a missing profile.
    return [absentEffect(`${result.page.cursor.region_id}:missing-measurement`)];
  }
  const effects = rows.map(effectFromMeasurement);
  const admission = interpretation?.interpretation_proposal?.stored_cosine_admission;
  if (admission === undefined || interpretation === undefined) return effects;
  const measurements = [...prior, ...rows].reverse();
  for (const row of rows) {
    if (row.raw.status !== "measured" || row.cap.status !== "projected") continue;
    const targetKey = JSON.stringify(row.raw.referent);
    const compatible = admission.obligations.map((obligation) => measurements.find((candidate) => candidate.raw.status === "measured"
      && candidate.raw.obligation_id === obligation.obligation_id && JSON.stringify(candidate.raw.referent) === targetKey));
    const projected = compatible.flatMap((candidate) => {
      if (candidate?.cap.status !== "projected" || candidate.raw.status !== "measured") return [];
      const contract = projectedCapContract(candidate.cap, candidate.raw.normalization);
      return [{ milligrades: candidate.cap.milligrades, contract, contract_id: capContractId(contract) }];
    });
    if (projected.length === 0 || admission.join === "all" && projected.length !== admission.obligations.length) continue;
    const contractIds = new Set(projected.map((item) => item.contract_id));
    if (contractIds.size !== 1) continue;
    const observation = result.page.observations.find((candidate) => candidate.observation_id === row.observation_id);
    if (observation === undefined || observation.applicability.verdict !== "true") continue;
    const grades = projected.map((item) => item.milligrades);
    const grade = admission.join === "all" ? Math.min(...grades) : Math.max(...grades);
    const contractId = projected[0]!.contract_id;
    for (const seed of seedActivationsForObservation({ ...observation, target: row.raw.referent,
      association_milligrades: grade }, interpretation, asOf, bindingContexts)) {
      effects.push({ observation_id: `${row.observation_id}:${seed.state.hypothesis_id}:${seed.state.program_state}`,
        seed: { ...seed, cap_contract_id: contractId }, admitted_seed: true });
    }
  }
  return effects;
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

function projectedCapContract(cap: Extract<ProjectedCap, { readonly status: "projected" }>, normalization: string): AssociationCapContract {
  return {
    domain_id: cap.domain_id,
    normalization,
    transfer_id: cap.transfer_id,
    transfer_version: cap.transfer_version
  };
}

export function measurementIsMissing(effects: readonly FieldObservationEffect[]): boolean {
  return effects.some((effect) =>
    effect.missing_measurement === true
    || (effect.raw_measurement !== undefined && effect.raw_measurement.status !== "measured")
  );
}
