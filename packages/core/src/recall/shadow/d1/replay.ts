import type { LexicalBoundProof } from "../../runtime/diagnostics/lexical-bound-proof.js";
import { freezeShadow, ShadowContractError } from "../envelope.js";
import {
  isPsiCycleFailure,
  peelUndominated
} from "../frontier-peel.js";
import type { ShadowFrontierReceipt } from "../frontiers.js";
import type { ShadowLineageId } from "../observations.js";
import {
  eligibleCandidateKeys,
  psiPredicate,
  type ShadowPsiObservationField,
  type ShadowPsiOutcome
} from "../psi.js";
import type { ShadowSetUtilityInput } from "../capture.js";
import {
  deterministicTailDecidedThisPick,
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type ShadowCapturedWalk,
  type ShadowCaptureWalkCandidate
} from "../walk.js";
import { d1LaneEnvelopes } from "./legal-envelope.js";
import { d1PsiOutcome, d1PsiPredicate } from "./interval-psi.js";

export type D1ReplayInput = Readonly<{
  readonly observations: ShadowPsiObservationField;
  readonly applicableChannels: readonly ShadowLineageId[];
  readonly proofs: readonly LexicalBoundProof[];
  readonly utilities: Readonly<Record<string, ShadowSetUtilityInput>>;
  readonly candidates?: readonly ShadowCaptureWalkCandidate[];
  readonly token_budget?: number;
  readonly per_dimension_limits?: Readonly<Record<string, number>> | null;
  readonly gold_keys?: readonly string[];
}>;

export type D1MissingnessCoverage = Readonly<{
  readonly production_not_observed: number;
  readonly legal_lane_envelopes: number;
  readonly unbounded_lane_envelopes: number;
  readonly inapplicable_lane_envelopes: number;
}>;

export type D1ReplayMetrics = Readonly<{
  readonly missingness: D1MissingnessCoverage;
  readonly blocked_pair_share: number;
  readonly eligible_pair_count: number;
  readonly blocked_pair_count: number;
  readonly f1_over_h: number;
  readonly f1_size: number;
  readonly h_size: number;
  readonly receipt_backed_dominance_edges: number;
  readonly equal_g_cohort_shrink: Readonly<{
    readonly baseline_cohorts_gt_1: number;
    readonly shrunk: number;
  }>;
  readonly mean_max_g_cohort_size: number;
  readonly deterministic_tail_share: number;
  readonly any_at_5: boolean | null;
}>;

export type D1ReplayResult =
  | Readonly<{
    readonly kind: "replayed";
    readonly metrics: D1ReplayMetrics;
    readonly d1_walk: ShadowCapturedWalk;
    readonly baseline_walk: ShadowCapturedWalk;
    readonly d1_frontiers: ShadowFrontierReceipt;
    readonly prefix_sk_5: readonly string[];
  }>
  | Readonly<{
    readonly kind: "psi_cycle_contract_failure";
    readonly stage: "d1_frontier" | "d1_walk" | "baseline_walk";
  }>;

export function replayD1CaptureWalk(input: D1ReplayInput): D1ReplayResult {
  const eligible = eligibleCandidateKeys(input.observations);
  const d1Psi = d1PsiPredicate(input.observations, input.applicableChannels, input.proofs);
  const baselinePsi = psiPredicate(input.observations, input.applicableChannels);
  const frontiers = peelUndominated(eligible, d1Psi);
  if (isPsiCycleFailure(frontiers)) {
    return freezeShadow({ kind: "psi_cycle_contract_failure", stage: "d1_frontier" as const });
  }
  const candidates = walkCandidates(input, eligible);
  const walks = runWalks(input, candidates, d1Psi, baselinePsi);
  if (walks.kind !== "walked") return walks;
  return freezeShadow({
    kind: "replayed",
    metrics: metricsFrom(input, eligible, frontiers, walks.d1, walks.baseline, d1Psi, baselinePsi),
    d1_walk: walks.d1,
    baseline_walk: walks.baseline,
    d1_frontiers: frontiers,
    prefix_sk_5: prefixSK(walks.d1.S_infty, 5)
  });
}

function runWalks(
  input: D1ReplayInput,
  candidates: readonly ShadowCaptureWalkCandidate[],
  d1Psi: (v: string, u: string) => boolean,
  baselinePsi: (v: string, u: string) => boolean
): Readonly<{
  readonly kind: "walked";
  readonly d1: ShadowCapturedWalk;
  readonly baseline: ShadowCapturedWalk;
}> | Extract<D1ReplayResult, { kind: "psi_cycle_contract_failure" }> {
  const budget = input.token_budget ?? 10_000;
  const limits = input.per_dimension_limits ?? null;
  const d1 = walkShadowCapture({
    candidates, psi: d1Psi, token_budget: budget, per_dimension_limits: limits
  });
  if (!isCapturedWalk(d1)) {
    return freezeShadow({ kind: "psi_cycle_contract_failure", stage: "d1_walk" as const });
  }
  const baseline = walkShadowCapture({
    candidates, psi: baselinePsi, token_budget: budget, per_dimension_limits: limits
  });
  if (!isCapturedWalk(baseline)) {
    return freezeShadow({ kind: "psi_cycle_contract_failure", stage: "baseline_walk" as const });
  }
  return { kind: "walked", d1, baseline };
}

function metricsFrom(
  input: D1ReplayInput,
  eligible: readonly string[],
  frontiers: ShadowFrontierReceipt,
  d1Walk: ShadowCapturedWalk,
  baselineWalk: ShadowCapturedWalk,
  d1Psi: (v: string, u: string) => boolean,
  baselinePsi: (v: string, u: string) => boolean
): D1ReplayMetrics {
  const blocked = blockedPairs(eligible, input);
  const f1 = frontiers.layers[0]?.member_keys.length ?? 0;
  const shrink = equalGShrink(baselineWalk, d1Walk);
  const cohortSizes = d1Walk.decisions.map((row) => row.max_g_cohort.length);
  const tailHits = d1Walk.decisions.filter((row) => deterministicTailDecidedThisPick(row));
  return Object.freeze({
    missingness: missingnessCoverage(eligible, input),
    blocked_pair_share: blocked.share,
    eligible_pair_count: blocked.pairs,
    blocked_pair_count: blocked.blocked,
    f1_over_h: eligible.length === 0 ? 0 : f1 / eligible.length,
    f1_size: f1,
    h_size: eligible.length,
    receipt_backed_dominance_edges: dominanceEdges(eligible, d1Psi, baselinePsi),
    equal_g_cohort_shrink: shrink,
    mean_max_g_cohort_size: mean(cohortSizes),
    deterministic_tail_share: d1Walk.decisions.length === 0
      ? 0
      : tailHits.length / d1Walk.decisions.length,
    any_at_5: input.gold_keys === undefined
      ? null
      : goldInPrefix(input.gold_keys, prefixSK(d1Walk.S_infty, 5))
  });
}

function missingnessCoverage(
  eligible: readonly string[],
  input: D1ReplayInput
): D1MissingnessCoverage {
  let productionNotObserved = 0;
  let legal = 0;
  let unbounded = 0;
  let inapplicable = 0;
  for (const key of eligible) {
    const lexical = input.observations[key]?.lineages.lexical;
    if (lexical?.envelope.state !== "not_observed") continue;
    productionNotObserved += 1;
    for (const proof of input.proofs) {
      for (const lane of Object.values(d1LaneEnvelopes(proof, key).lanes)) {
        if (lane === undefined) continue;
        if (lane.value.kind === "interval") legal += 1;
        else if (lane.value.kind === "inapplicable") inapplicable += 1;
        else unbounded += 1;
      }
    }
  }
  return Object.freeze({
    production_not_observed: productionNotObserved,
    legal_lane_envelopes: legal,
    unbounded_lane_envelopes: unbounded,
    inapplicable_lane_envelopes: inapplicable
  });
}

function blockedPairs(
  eligible: readonly string[],
  input: D1ReplayInput
): Readonly<{ readonly pairs: number; readonly blocked: number; readonly share: number }> {
  let pairs = 0;
  let blocked = 0;
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      pairs += 1;
      const outcome = d1PsiOutcome(
        eligible[i]!, eligible[j]!, input.observations, input.applicableChannels, input.proofs
      );
      if (isBlocked(outcome)) blocked += 1;
    }
  }
  return Object.freeze({
    pairs,
    blocked,
    share: pairs === 0 ? 0 : blocked / pairs
  });
}

function dominanceEdges(
  eligible: readonly string[],
  d1Psi: (v: string, u: string) => boolean,
  baselinePsi: (v: string, u: string) => boolean
): number {
  let count = 0;
  for (const v of eligible) {
    for (const u of eligible) {
      if (v === u) continue;
      if (d1Psi(v, u) && !baselinePsi(v, u)) count += 1;
    }
  }
  return count;
}

function equalGShrink(
  baseline: ShadowCapturedWalk,
  d1: ShadowCapturedWalk
): D1ReplayMetrics["equal_g_cohort_shrink"] {
  let baselineCohorts = 0;
  let shrunk = 0;
  const n = Math.min(baseline.decisions.length, d1.decisions.length);
  for (let index = 0; index < n; index += 1) {
    const base = baseline.decisions[index]!;
    if (base.max_g_cohort.length <= 1) continue;
    baselineCohorts += 1;
    if (psiCohortSize(d1.decisions[index]!) < psiCohortSize(base)) shrunk += 1;
  }
  return Object.freeze({ baseline_cohorts_gt_1: baselineCohorts, shrunk });
}

function walkCandidates(
  input: D1ReplayInput,
  eligible: readonly string[]
): readonly ShadowCaptureWalkCandidate[] {
  if (input.candidates !== undefined) return input.candidates;
  return Object.freeze(eligible.map((key) => {
    const utility = input.utilities[key];
    if (utility === undefined) {
      throw new ShadowContractError(`missing frozen utility for ${key}`);
    }
    return freezeShadow({
      candidate_key: key,
      object_key: utility.object_key,
      token_cost: 1,
      dimension: "mem",
      h_eligible: input.observations[key]?.h_gate === "none",
      utility,
      static_frontier_index: null
    });
  }));
}

function psiCohortSize(
  receipt: ShadowCapturedWalk["decisions"][number]
): number {
  return receipt.max_g_cohort.length - receipt.equal_g_dominance_rejects.length;
}

function goldInPrefix(golds: readonly string[], prefix: readonly string[]): boolean {
  const set = new Set(prefix);
  return golds.some((key) => set.has(key));
}

function isBlocked(
  outcome: ShadowPsiOutcome | { readonly kind: string }
): boolean {
  return outcome.kind === "blocked";
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
