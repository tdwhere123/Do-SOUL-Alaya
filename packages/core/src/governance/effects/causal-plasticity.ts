import {
  type CausalUsageKind,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";

export const USAGE_STRENGTH_CAP = 1;
export const DEFAULT_USAGE_DECAY_PER_MS = Math.log(2) / (30 * 24 * 60 * 60 * 1000);

export type PlasticityChannel = "usage" | "inhibitory";
export type PlasticityCreditKind = CausalUsageKind | "top_k";

export type PlasticityCredit = Readonly<{
  readonly receipt: CausalUsageReceipt;
  readonly channel: PlasticityChannel;
}>;

export type SoftUsageProjection = Readonly<{
  readonly mass: number;
  readonly strength: number;
  readonly hard_relation: false;
}>;

export function usageWeightFor(kind: PlasticityCreditKind): number {
  return kind === "causal" ? 1 : 0;
}

export function projectUsageMass(
  credits: readonly PlasticityCredit[],
  asOf: string,
  decayPerMs: number = DEFAULT_USAGE_DECAY_PER_MS
): number {
  const asOfMs = Date.parse(asOf);
  let mass = 0;
  for (const credit of uniqueCredits(credits)) {
    const elapsed = Math.max(0, asOfMs - Date.parse(credit.receipt.occurred_at));
    const contribution = credit.receipt.weight * Math.exp(-decayPerMs * elapsed);
    mass += credit.channel === "inhibitory" ? -contribution : contribution;
  }
  return Math.max(0, mass);
}

export function projectUsageStrength(
  mass: number,
  uMax: number = USAGE_STRENGTH_CAP
): number {
  return uMax * (1 - Math.exp(-Math.max(0, mass)));
}

export function projectSoftUsage(
  credits: readonly PlasticityCredit[],
  asOf: string,
  decayPerMs: number = DEFAULT_USAGE_DECAY_PER_MS,
  uMax: number = USAGE_STRENGTH_CAP
): SoftUsageProjection {
  const mass = projectUsageMass(credits, asOf, decayPerMs);
  return Object.freeze({
    mass,
    strength: projectUsageStrength(mass, uMax),
    hard_relation: false
  });
}

function uniqueCredits(credits: readonly PlasticityCredit[]): readonly PlasticityCredit[] {
  const seen = new Set<string>();
  const unique: PlasticityCredit[] = [];
  for (const credit of credits) {
    if (seen.has(credit.receipt.identity)) continue;
    seen.add(credit.receipt.identity);
    unique.push(credit);
  }
  return unique;
}
