import {
  type CausalUsageKind,
  type CausalUsageReceipt
} from "@do-soul/alaya-protocol";

export const USAGE_STRENGTH_CAP = 1;
export const USAGE_MASS_CAP = 32;
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
  readonly writes_path_relation: false;
}>;

export const USAGE_ADAPTATION_NECESSITY_MECHANISMS = Object.freeze([
  "reinforcement_decay",
  "conditional_program_learning",
  "cost_informed_scheduling",
  "exact_path_compilation"
] as const);

export type UsageAdaptationMechanism = (typeof USAGE_ADAPTATION_NECESSITY_MECHANISMS)[number];
export type UsageAdaptationDisposition = "NOT_REQUIRED" | "BENEFIT_NOT_ESTABLISHED";

export type UsageAdaptationNecessityRow = Readonly<{
  readonly mechanism: UsageAdaptationMechanism;
  readonly unmet_need: string;
  readonly identifiable_signal: string;
  readonly exposure_assumptions: string;
  readonly counterexample: string;
  readonly cost: string;
  readonly disposition: UsageAdaptationDisposition;
  readonly working_reference: string;
}>;

const NO_LEARNER_REFERENCE =
  "projectCausalUsageOntoPaths leaves PathRelation.strength unchanged; " +
  "createAttributionOnlyPathPlasticityPort never writes PathRelation; " +
  "historical CausalUsageReceipt rows remain";

export const USAGE_ADAPTATION_NECESSITY: Readonly<
  Record<UsageAdaptationMechanism, UsageAdaptationNecessityRow>
> = Object.freeze({
  reinforcement_decay: Object.freeze({
    mechanism: "reinforcement_decay",
    unmet_need:
      "A declared cardinal scale and update rule; the ordinal min/max algebra does not supply one, and the reference field is well-defined without persistent reinforcement or temporal decay.",
    identifiable_signal:
      "Unique usage-receipt identity and reported_use at the declared grain. Elapsed nonuse and missing reports are not negatives.",
    exposure_assumptions:
      "Reports exist only for exposed items under the current policy. Nonexposure is not evidence against an unexposed witness.",
    counterexample:
      "Discount A=0.8 below B=0.5, then relabel by w^2 and the same 1/2 discount keeps A above B. An output-only used report on x is consistent with witnesses (a,b,x) and (a,c,x) and cannot identify edge credit.",
    cost:
      "Persisted strength writes, watermarked reapplication, ordinal-scale dependence, and treating popularity as relation support.",
    disposition: "NOT_REQUIRED",
    working_reference: NO_LEARNER_REFERENCE
  }),
  conditional_program_learning: Object.freeze({
    mechanism: "conditional_program_learning",
    unmet_need:
      "Labeled query-program pairs, a declared loss against the target index, a transfer context, and an update rule that does not rewrite association as proposition truth.",
    identifiable_signal:
      "None frozen. Usage logs describe Pr(Y=1|E=1,q,Σ,π), not intrinsic relation truth or unexposed-path usefulness.",
    exposure_assumptions:
      "Observational reports under the current policy do not identify the counterfactual value of supplying a different witness.",
    counterexample:
      "A policy that exposes one path more often collects more reports and then treats those reports as a reason to expose it still more often.",
    cost:
      "A new semantic model version, a labeled workload, and the risk of starving eligible observers while claiming coverage.",
    disposition: "BENEFIT_NOT_ESTABLISHED",
    working_reference: NO_LEARNER_REFERENCE
  }),
  cost_informed_scheduling: Object.freeze({
    mechanism: "cost_informed_scheduling",
    unmet_need:
      "A representative workload, measured index loss under an admissible policy class, and physical-work accounting already owned by observers.",
    identifiable_signal:
      "Native-read, join, and expansion cost exist as work. Consumer-value labels for schedule changes do not.",
    exposure_assumptions:
      "Budgeted policies can change the observed index. That is not a measured user-value gain, and report count is not lower loss.",
    counterexample:
      "Finite mathematical examples are not workload gains. Using learned popularity to certify a semantic bound can starve a finite region while claiming progress.",
    cost:
      "A scheduler-learning surface, extra persisted policy state, and silent substitution of report volume for target loss.",
    disposition: "BENEFIT_NOT_ESTABLISHED",
    working_reference: NO_LEARNER_REFERENCE
  }),
  exact_path_compilation: Object.freeze({
    mechanism: "exact_path_compilation",
    unmet_need:
      "A compiler that revalidates guards, intermediates, and source/model/projection dependencies. Usage frequency is not that check.",
    identifiable_signal:
      "Repeated identical legal programs. Repetition does not license generalization of bindings or time conditions.",
    exposure_assumptions:
      "A summary must remain expandable to the original witness. After an input lapses, the compiled grade cannot be reused without revalidation.",
    counterexample:
      "A 0.8 then 0.4 chain compiles to 0.4; if the second edge ceases to apply, reusing the summary invents a route the current model lacks. A compiled path is not new independent support.",
    cost:
      "A reuse/cache service, silent alternative suppression, and mixed-epoch shortcut past a revoked intermediate.",
    disposition: "NOT_REQUIRED",
    working_reference: NO_LEARNER_REFERENCE
  })
});

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
    const occurredAtMs = Date.parse(credit.receipt.occurred_at);
    if (occurredAtMs > asOfMs) continue;
    const elapsed = asOfMs - occurredAtMs;
    const contribution = credit.receipt.weight * Math.exp(-decayPerMs * elapsed);
    mass += credit.channel === "inhibitory" ? -contribution : contribution;
  }
  return Math.min(USAGE_MASS_CAP, Math.max(0, mass));
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
    hard_relation: false,
    writes_path_relation: false
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
