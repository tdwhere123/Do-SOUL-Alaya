import { CONDITIONAL_FIELD_SCHEMA_VERSION, type Witness } from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import {
  joinHyperedgeAnd,
  joinHyperedgeOr,
  type HyperedgePremise
} from "../reference/accepting-projection.js";
import { contextCompatible } from "./governance.js";
import type {
  EvidenceIdentityContext,
  EvidenceObservation,
  EvidencePolarity,
  PolarizedWitness,
  WitnessTemplate
} from "./types.js";

export class SupportWorkMeter {
  remaining: number;
  interrupted: boolean;

  public constructor(limit: number) {
    this.remaining = Math.max(0, limit);
    this.interrupted = limit <= 0;
  }

  public spend(): boolean {
    if (this.remaining <= 0) {
      this.interrupted = true;
      return false;
    }
    this.remaining -= 1;
    return true;
  }
}

export function compatiblePremises(
  observations: readonly EvidenceObservation[],
  context: EvidenceIdentityContext
): boolean {
  if (observations.length === 0) return false;
  if (!observations.every((observation) => contextCompatible(observation, context))) return false;
  const premises: HyperedgePremise[] = observations.map((observation) => ({
    hypothesis_id: observation.hypothesis_id,
    binding_context: observation.binding_context,
    time_state: observation.time_state,
    present: true
  }));
  return joinHyperedgeAnd(premises);
}

export function completeWitnessesFor(
  templates: readonly WitnessTemplate[],
  observations: readonly EvidenceObservation[],
  polarity: EvidencePolarity,
  context: EvidenceIdentityContext,
  work: SupportWorkMeter
): readonly PolarizedWitness[] {
  const witnesses: PolarizedWitness[] = [];
  for (const template of templates) {
    if (!work.spend()) break;
    witnesses.push(witnessFromTemplate(template, observations, polarity, context));
  }
  return retainCompleteAlternatives(witnesses);
}

export function retainCompleteAlternatives(
  witnesses: readonly PolarizedWitness[]
): readonly PolarizedWitness[] {
  // Cost-then-id sort must not drop a cheaper complete alternative.
  const complete = joinHyperedgeOr(witnesses) as readonly PolarizedWitness[];
  const unique = new Map<string, PolarizedWitness>();
  for (const witness of complete) {
    const key = `${witness.polarity}\0${witness.witness_id}`;
    if (!unique.has(key)) unique.set(key, witness);
  }
  return [...unique.values()].sort(compareWitnesses);
}

export function explanationIdsFrom(witnesses: readonly Witness[]): readonly string[] {
  return joinHyperedgeOr(witnesses)
    .slice()
    .sort(compareWitnesses)
    .map((witness) => witness.witness_id);
}

function witnessFromTemplate(
  template: WitnessTemplate,
  observations: readonly EvidenceObservation[],
  polarity: EvidencePolarity,
  context: EvidenceIdentityContext
): PolarizedWitness {
  const chosen: EvidenceObservation[] = [];
  for (const premiseId of template.premises) {
    const match = observations.find((observation) =>
      observation.premise_id === premiseId && observation.polarity === polarity
    );
    if (match === undefined) return incompleteWitness(template, polarity);
    chosen.push(match);
  }
  if (!compatiblePremises(chosen, context)) return incompleteWitness(template, polarity);
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    witness_id: polarizedWitnessId(template.witness_id, polarity),
    premises: template.premises,
    cost: template.cost,
    complete: true,
    polarity
  };
}

function polarizedWitnessId(witnessId: string, polarity: EvidencePolarity): string {
  return `${witnessId}/${polarity}`;
}

function incompleteWitness(template: WitnessTemplate, polarity: EvidencePolarity): PolarizedWitness {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    witness_id: polarizedWitnessId(template.witness_id, polarity),
    premises: template.premises,
    cost: template.cost,
    complete: false,
    polarity
  };
}

function compareWitnesses(left: Witness, right: Witness): number {
  if (left.cost !== right.cost) return left.cost - right.cost;
  return compareText(left.witness_id, right.witness_id);
}
