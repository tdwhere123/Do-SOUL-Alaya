import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { compileRecallQueryDemand } from "../query/recall-query-demand.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey
} from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData,
  TokenEstimator
} from "../runtime/recall-service-types.js";
import {
  parseSetUtilityInput,
  type ShadowGStatus,
  type ShadowSetUtilityInput
} from "./capture.js";
import { shadowLineageApplicability } from "./demand.js";
import { freezeShadow } from "./envelope.js";
import { isPsiCycleFailure, peelUndominated } from "./frontier-peel.js";
import type { ShadowFrontierReceipt } from "./frontiers.js";
import {
  D0_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION
} from "./identity.js";
import {
  SHADOW_LINEAGE_IDS,
  type ShadowLineageId
} from "./observations.js";
import {
  buildLiveObservationField,
  liveLexicalMapping
} from "./live-observations.js";
import {
  eligibleCandidateKeys,
  e0MembershipSubsetOfE1,
  psiOutcome,
  psiPredicate,
  type ShadowPsiObservationField
} from "./psi.js";
import type {
  ShadowCoreKnownNoWitness,
  ShadowEqualGReject
} from "./receipts.js";
import {
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type PsiQuery,
  type ShadowCapturedWalk,
  type ShadowCaptureWalkCandidate
} from "./walk.js";

export type { PsiQuery } from "./walk.js";
export type { ShadowPsiObservationField } from "./psi.js";
export { prefixSK } from "./walk.js";

export type ShadowC0Seam = Readonly<{
  readonly owner: "fineAssess";
  readonly activation: "active" | "inactive";
  readonly future_delivery_order: "prefixSK(S_infty, K)";
  readonly rollback: "deliverFineAssessment";
}>;

export function shadowC0Seam(
  activation: ShadowC0Seam["activation"]
): ShadowC0Seam {
  return freezeShadow({
    owner: "fineAssess",
    activation,
    future_delivery_order: "prefixSK(S_infty, K)",
    rollback: "deliverFineAssessment"
  } as const);
}

export const SHADOW_C0_SEAM = shadowC0Seam("inactive");

export type ShadowFailClosedReason =
  | "psi_cycle_contract_failure"
  | "invalid_state"
  | "membership_shrink"
  | "prefix_violation";

export type ShadowIntegrateInput = Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly observationField?: ShadowPsiObservationField;
  readonly psi?: PsiQuery;
  readonly e0Keys?: readonly string[];
  readonly e1Keys?: readonly string[];
  readonly utilitiesByKey?: ReadonlyMap<string, ShadowSetUtilityInput>;
  readonly c0Activation?: ShadowC0Seam["activation"];
  readonly memoryKeywordLanes?: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly nowIso?: string;
}>;

export type ShadowFailClosedTrace = Readonly<{
  readonly kind: "fail_closed";
  readonly reason: ShadowFailClosedReason;
  readonly algorithm_id: typeof SHADOW_ALGORITHM_ID;
  readonly version: typeof SHADOW_ALGORITHM_VERSION;
  readonly digest: typeof D0_IDENTITY_DIGEST;
  readonly c0_seam: ShadowC0Seam;
}>;

export type ShadowCapturedTrace = Readonly<{
  readonly kind: "captured";
  readonly algorithm_id: typeof SHADOW_ALGORITHM_ID;
  readonly version: typeof SHADOW_ALGORITHM_VERSION;
  readonly digest: typeof D0_IDENTITY_DIGEST;
  readonly c0_seam: ShadowC0Seam;
  readonly lexical_mapping: "planted" | "lane_receipts" | "not_observed";
  readonly admitted_lineages: typeof SHADOW_LINEAGE_IDS;
  readonly relational_o: "excluded";
  readonly eligible_keys: readonly string[];
  readonly frontiers: ShadowFrontierReceipt;
  readonly S_infty: readonly string[];
  readonly prefix_proposal: readonly string[];
  readonly K: number;
  readonly decisions: ShadowCapturedWalk["decisions"];
  readonly walk_rejects: ShadowCapturedWalk["walk_rejects"];
  readonly max_g_cohort: readonly string[];
  readonly equal_g_dominance_rejects: readonly ShadowEqualGReject[];
  readonly gamma_availability: ShadowGStatus | null;
  readonly unresolved_pointwise_tradeoff: boolean;
  readonly core_known_no_witness: readonly ShadowCoreKnownNoWitness[];
}>;

export type FineAssessmentShadowTrace = ShadowCapturedTrace | ShadowFailClosedTrace;

export function captureShadowIntegration(
  input: ShadowIntegrateInput
): FineAssessmentShadowTrace {
  try {
    return runShadowIntegration(input);
  } catch {
    return failClosed("invalid_state", c0ActivationOf(input));
  }
}

export function isFailClosedShadowTrace(
  trace: FineAssessmentShadowTrace
): trace is ShadowFailClosedTrace {
  return trace.kind === "fail_closed";
}

function runShadowIntegration(
  input: ShadowIntegrateInput
): FineAssessmentShadowTrace {
  const activation = c0ActivationOf(input);
  const keys = input.candidates.map(buildRecallCandidateDedupeKey);
  if (!membershipHolds(input, keys)) return failClosed("membership_shrink", activation);
  const observations = resolveObservations(input, keys);
  const channels = resolveChannels(observations, input);
  const eligible = eligibleCandidateKeys(observations).filter((key) => keys.includes(key));
  const psi = input.psi ?? psiPredicate(observations, channels);
  const peeled = peelUndominated(eligible, psi);
  if (isPsiCycleFailure(peeled)) return failClosed("psi_cycle_contract_failure", activation);
  const walked = walkShadowCapture(
    buildWalkInput(input, keys, observations, peeled, psi, channels)
  );
  if (!isCapturedWalk(walked)) return failClosed("psi_cycle_contract_failure", activation);
  if (!prefixMonotone(walked.S_infty)) return failClosed("prefix_violation", activation);
  return assembleCaptured(input, eligible, peeled, walked, observations);
}

function membershipHolds(
  input: ShadowIntegrateInput,
  keys: readonly string[]
): boolean {
  const e1 = input.e1Keys ?? keys;
  const e0 = input.e0Keys ?? keys;
  return e0MembershipSubsetOfE1(e0, e1);
}

function resolveObservations(
  input: ShadowIntegrateInput,
  keys: readonly string[]
): ShadowPsiObservationField {
  if (input.observationField !== undefined) {
    for (const key of keys) {
      if (input.observationField[key] === undefined) {
        throw new Error("planted observation field missing substrate key");
      }
    }
    return input.observationField;
  }
  return honestObservationField(input, keys);
}

function honestObservationField(
  input: ShadowIntegrateInput,
  keys: readonly string[]
): ShadowPsiObservationField {
  const field = buildLiveObservationField({
    candidates: input.candidates,
    policy: input.policy,
    supplementaryData: input.supplementaryData,
    memoryKeywordLanes: input.memoryKeywordLanes,
    nowIso: input.nowIso
  });
  for (const key of keys) {
    if (field[key] === undefined) {
      throw new Error("live observation field missing substrate key");
    }
  }
  return field;
}

function resolveChannels(
  observations: ShadowPsiObservationField,
  input: ShadowIntegrateInput
): readonly ShadowLineageId[] {
  const present = new Set<ShadowLineageId>();
  for (const view of Object.values(observations)) {
    for (const lineage of SHADOW_LINEAGE_IDS) {
      if (view?.lineages[lineage] !== undefined) present.add(lineage);
    }
  }
  if (present.size > 0) {
    return SHADOW_LINEAGE_IDS.filter((lineage) => present.has(lineage));
  }
  const probes = input.supplementaryData.queryProbes;
  const applicable = shadowLineageApplicability({
    demand: compileRecallQueryDemand(probes),
    probes,
    arm: input.policy.coarse_filter.semantic_supplement.embedding_enabled === true
      ? "E1"
      : "E0"
  });
  return SHADOW_LINEAGE_IDS.filter((lineage) => applicable[lineage]);
}

function buildWalkInput(
  input: ShadowIntegrateInput,
  keys: readonly string[],
  observations: ShadowPsiObservationField,
  frontiers: ShadowFrontierReceipt,
  psi: PsiQuery,
  channels: readonly ShadowLineageId[]
): Parameters<typeof walkShadowCapture>[0] {
  const budgets = input.policy.fine_assessment.budgets;
  const indexByKey = frontierIndexByKey(frontiers);
  const candidates = input.candidates.map((candidate, offset) =>
    toWalkCandidate(candidate, keys[offset]!, observations, input, indexByKey)
  );
  return {
    candidates,
    psi,
    token_budget: budgets.max_total_tokens,
    per_dimension_limits: budgets.per_dimension_limits,
    unresolved_tradeoff: input.psi === undefined
      ? tradeoffQuery(observations, channels)
      : undefined
  };
}

function toWalkCandidate(
  candidate: Readonly<CoarseRecallCandidate>,
  key: string,
  observations: ShadowPsiObservationField,
  input: ShadowIntegrateInput,
  indexByKey: ReadonlyMap<string, number>
): ShadowCaptureWalkCandidate {
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const tokens = input.tokenEstimator.estimate(candidate.entry.content);
  return freezeShadow({
    candidate_key: key,
    object_key: objectKey,
    token_cost: Number.isFinite(tokens) && tokens > 0 ? tokens : 1,
    dimension: candidate.entry.dimension,
    h_eligible: observations[key]?.h_gate === "none",
    utility: input.utilitiesByKey?.get(key) ?? emptyUtility(key, objectKey),
    static_frontier_index: indexByKey.get(key) ?? null
  });
}

function emptyUtility(candidateKey: string, objectKey: string): ShadowSetUtilityInput {
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: candidateKey,
    object_key: objectKey,
    obligations: [],
    matches: [],
    values: { status: "no_match", values: [] },
    cid: { status: "unavailable" },
    availability: {
      facility: "not_applicable",
      values: "no_match",
      evidence_identity: "unavailable"
    }
  });
}

function frontierIndexByKey(
  frontiers: ShadowFrontierReceipt
): ReadonlyMap<string, number> {
  const indexByKey = new Map<string, number>();
  for (const layer of frontiers.layers) {
    for (const key of layer.member_keys) indexByKey.set(key, layer.index);
  }
  return indexByKey;
}

function tradeoffQuery(
  observations: ShadowPsiObservationField,
  channels: readonly ShadowLineageId[]
): (left: string, right: string) => boolean {
  return (left, right) => {
    const outcome = psiOutcome(left, right, observations, channels);
    return outcome.kind === "tradeoff";
  };
}

function prefixMonotone(S_infty: readonly string[]): boolean {
  for (let k = 1; k <= S_infty.length; k += 1) {
    const prefix = prefixSK(S_infty, k);
    const next = prefixSK(S_infty, k + 1);
    if (prefix.some((key, offset) => key !== next[offset])) return false;
  }
  return true;
}

function assembleCaptured(
  input: ShadowIntegrateInput,
  eligible: readonly string[],
  frontiers: ShadowFrontierReceipt,
  walked: ShadowCapturedWalk,
  observations: ShadowPsiObservationField
): ShadowCapturedTrace {
  const k = input.policy.fine_assessment.budgets.max_entries;
  const first = walked.decisions[0];
  return freezeShadow({
    kind: "captured" as const,
    algorithm_id: SHADOW_ALGORITHM_ID,
    version: SHADOW_ALGORITHM_VERSION,
    digest: D0_IDENTITY_DIGEST,
    c0_seam: shadowC0Seam(c0ActivationOf(input)),
    lexical_mapping: input.observationField === undefined
      ? liveLexicalMapping(observations)
      : "planted" as const,
    admitted_lineages: SHADOW_LINEAGE_IDS,
    relational_o: "excluded" as const,
    eligible_keys: Object.freeze([...eligible]),
    frontiers,
    S_infty: walked.S_infty,
    prefix_proposal: prefixSK(walked.S_infty, k),
    K: k,
    decisions: walked.decisions,
    walk_rejects: walked.walk_rejects,
    max_g_cohort: first?.max_g_cohort ?? Object.freeze([]),
    equal_g_dominance_rejects: first?.equal_g_dominance_rejects ?? Object.freeze([]),
    gamma_availability: first?.G_status ?? null,
    unresolved_pointwise_tradeoff: walked.decisions.some(
      (decision) => decision.unresolved_pointwise_tradeoff
    ),
    core_known_no_witness: Object.freeze(
      walked.decisions.flatMap((decision) => [...decision.novelty_core_known_absence])
    )
  });
}

export function failClosedShadowTrace(
  reason: ShadowFailClosedReason,
  activation: ShadowC0Seam["activation"] = "inactive"
): ShadowFailClosedTrace {
  return freezeShadow({
    kind: "fail_closed" as const,
    reason,
    algorithm_id: SHADOW_ALGORITHM_ID,
    version: SHADOW_ALGORITHM_VERSION,
    digest: D0_IDENTITY_DIGEST,
    c0_seam: shadowC0Seam(activation)
  });
}

function failClosed(
  reason: ShadowFailClosedReason,
  activation: ShadowC0Seam["activation"] = "inactive"
): ShadowFailClosedTrace {
  return failClosedShadowTrace(reason, activation);
}

function c0ActivationOf(input: ShadowIntegrateInput): ShadowC0Seam["activation"] {
  return input.c0Activation ?? "inactive";
}
