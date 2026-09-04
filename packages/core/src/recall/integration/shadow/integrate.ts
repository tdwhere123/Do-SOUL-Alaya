import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  KeywordLexicalMergeCapture,
  KeywordSearchLaneReceipt,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "../../runtime/recall-service-types.js";
import {
  emptySetUtilityInput,
  type ShadowGStatus,
  type ShadowSetUtilityInput
} from "../../decision/prefix-capture/capture.js";
import {
  issueObservationBackedPsiV2,
  observeTargetDeliveryPack,
  previewSidecar,
  type QueryProofPreviewRequest,
  type QueryProofPreviewRuntimeCapture,
  type QueryProofPreviewSource,
  type QueryProofPreviewSidecar
} from "./query-proof-preview.js";
import { shadowLineageApplicability } from "../../decision/query-proof/demand.js";
import { freezeShadow, ShadowContractError } from "../../decision/contract-primitives.js";
import { isPsiCycleFailure, peelUndominated } from "../../decision/query-proof/frontier-peel.js";
import type { ShadowFrontierReceipt } from "../../decision/query-proof/frontiers.js";
import {
  CAPTURE_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION
} from "../../decision/prefix-capture/identity.js";
import {
  SHADOW_LINEAGE_IDS,
  type ShadowLineageId
} from "../../decision/query-proof/observations.js";
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
} from "../../decision/query-proof/psi.js";
import {
  buildPsiV2ShadowDiagnostics,
  malformedPsiV2ShadowDiagnostics,
  type PsiV2ShadowDiagnosticsV1,
  type PsiV2ShadowInputV1
} from "../../decision/query-proof/dominance/index.js";
import type {
  ShadowCoreKnownNoWitness,
  ShadowEqualGReject
} from "../../decision/prefix-capture/receipts.js";
import {
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type ShadowCapturedWalk,
  type ShadowCaptureWalkCandidate
} from "../../decision/prefix-capture/walk.js";
import type { PsiQuery } from "../../decision/dominance-contract.js";
import type { LiveQueryProofAuthority } from
  "../../decision/query-proof/live-query-proof-authority.js";
import type { DeliveryPackV1 } from
  "../../decision/query-proof/delivery/contract.js";

export type { PsiQuery } from "../../decision/dominance-contract.js";
export type { ShadowPsiObservationField } from "../../decision/query-proof/psi.js";
export { prefixSK } from "../../decision/prefix-capture/walk.js";
export type { QueryProofPreviewRequest, QueryProofPreviewSidecar } from
  "./query-proof-preview.js";

export type ShadowCutoverSeam = Readonly<{
  readonly owner: "fineAssess";
  readonly activation: "active" | "inactive";
  readonly future_delivery_order: "prefixSK(S_infty, K)";
  readonly rollback: "deliverFineAssessment";
}>;

export function shadowCutoverSeam(
  activation: ShadowCutoverSeam["activation"]
): ShadowCutoverSeam {
  return freezeShadow({
    owner: "fineAssess",
    activation,
    future_delivery_order: "prefixSK(S_infty, K)",
    rollback: "deliverFineAssessment"
  } as const);
}

export const SHADOW_CUTOVER_SEAM = shadowCutoverSeam("inactive");

export type ShadowFailClosedReason = import("@do-soul/alaya-protocol").CaptureExecutionReason;

export type ShadowIntegrateInput = Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly warn?: RecallServiceWarnPort;
  readonly observationField?: ShadowPsiObservationField;
  readonly psi?: PsiQuery;
  readonly e0Keys?: readonly string[];
  readonly e1Keys?: readonly string[];
  readonly utilitiesByKey?: ReadonlyMap<string, ShadowSetUtilityInput>;
  readonly cutoverActivation?: ShadowCutoverSeam["activation"];
  readonly memoryKeywordLanes?: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly memoryLexicalCaptures?: readonly Readonly<KeywordLexicalMergeCapture>[];
  readonly nowIso?: string;
  readonly lexicalIntervalEnvelopesByKey?: PsiV2ShadowInputV1["lexical_interval_by_key"];
  readonly lexical_measurement_authority?:
  PsiV2ShadowInputV1["lexical_measurement_authority"];
  readonly supportMaterialization?: PsiV2ShadowInputV1["support"];
  readonly support_measurement_authority?:
  PsiV2ShadowInputV1["support_measurement_authority"];
  readonly query_proof_authority?: LiveQueryProofAuthority;
  readonly psi_v2_producer_outcomes?: PsiV2ShadowInputV1["producer_outcomes"];
  readonly query_id?: string;
  readonly snapshot_digest?: string;
  readonly query_proof_preview?: QueryProofPreviewRequest;
}>;

export type ShadowFailClosedTrace = Readonly<{
  readonly kind: "fail_closed";
  readonly reason: ShadowFailClosedReason;
  readonly algorithm_id: typeof SHADOW_ALGORITHM_ID;
  readonly version: typeof SHADOW_ALGORITHM_VERSION;
  readonly digest: typeof CAPTURE_IDENTITY_DIGEST;
  readonly cutover_seam: ShadowCutoverSeam;
}>;

export type ShadowCapturedTrace = Readonly<{
  readonly kind: "captured";
  readonly algorithm_id: typeof SHADOW_ALGORITHM_ID;
  readonly version: typeof SHADOW_ALGORITHM_VERSION;
  readonly digest: typeof CAPTURE_IDENTITY_DIGEST;
  readonly cutover_seam: ShadowCutoverSeam;
  readonly lexical_mapping: "planted" | "raw_rank_capture" | "lane_receipts" | "not_observed";
  readonly admitted_lineages: typeof SHADOW_LINEAGE_IDS;
  readonly relational_o: "excluded";
  readonly eligible_keys: readonly string[];
  readonly field_membership: Readonly<{
    readonly e0_keys: readonly string[];
    readonly e1_keys: readonly string[];
  }>;
  readonly observations_by_candidate_key: ShadowPsiObservationField;
  readonly set_utilities: readonly ShadowSetUtilityInput[];
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
  readonly psi_v2_shadow: PsiV2ShadowSidecar;
  readonly query_proof_preview?: QueryProofPreviewSidecar;
  readonly delivery_pack: DeliveryPackV1;
}>;

export type PsiV2ShadowSidecar = PsiV2ShadowDiagnosticsV1;

export type FineAssessmentShadowTrace = ShadowCapturedTrace | ShadowFailClosedTrace;

export function captureShadowIntegration(
  input: ShadowIntegrateInput
): FineAssessmentShadowTrace {
  try {
    return runShadowIntegration(input);
  } catch (error) {
    if (error instanceof ShadowContractError) {
      return failClosed("invalid_state", cutoverActivationOf(input));
    }
    throw error;
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
  const activation = cutoverActivationOf(input);
  const keys = input.candidates.map(buildRecallCandidateDedupeKey);
  if (!membershipHolds(input, keys)) return failClosed("membership_shrink", activation);
  const observations = resolveObservations(input, keys);
  const channels = resolveChannels(observations, input);
  const eligible = eligibleCandidateKeys(observations).filter((key) => keys.includes(key));
  const psi = memoizeRequestPsi(input.psi ?? psiPredicate(observations, channels));
  const peeled = peelUndominated(eligible, psi);
  if (isPsiCycleFailure(peeled)) return failClosed("psi_cycle_contract_failure", activation);
  const walkInput = buildWalkInput(input, keys, observations, peeled, psi, channels);
  const walked = walkShadowCapture(walkInput);
  if (!isCapturedWalk(walked)) return failClosed("psi_cycle_contract_failure", activation);
  if (!prefixMonotone(walked.S_infty)) return failClosed("prefix_violation", activation);
  return assembleCaptured(input, eligible, peeled, walked, observations, walkInput);
}

export function memoizeRequestPsi(psi: PsiQuery): PsiQuery {
  const outcomes = new Map<string, Map<string, boolean>>();
  return (dominator, dominated) => {
    const byDominated = outcomes.get(dominator);
    const cached = byDominated?.get(dominated);
    if (cached !== undefined) return cached;
    const outcome = psi(dominator, dominated);
    if (byDominated === undefined) {
      outcomes.set(dominator, new Map([[dominated, outcome]]));
    } else {
      byDominated.set(dominated, outcome);
    }
    return outcome;
  };
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
        throw new ShadowContractError("planted observation field missing substrate key");
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
    memoryLexicalCaptures: input.memoryLexicalCaptures,
    nowIso: input.nowIso
  });
  for (const key of keys) {
    if (field[key] === undefined) {
      throw new ShadowContractError("live observation field missing substrate key");
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
    utility: utilityForCandidate(input, key, objectKey),
    static_frontier_index: indexByKey.get(key) ?? null
  });
}

function utilityForCandidate(
  input: ShadowIntegrateInput,
  candidateKey: string,
  objectKey: string
): ShadowSetUtilityInput {
  return input.utilitiesByKey?.get(candidateKey) ?? emptySetUtilityInput(candidateKey, objectKey);
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
  observations: ShadowPsiObservationField,
  walkInput: Parameters<typeof walkShadowCapture>[0]
): ShadowCapturedTrace {
  const k = input.policy.fine_assessment.budgets.max_entries;
  const first = walked.decisions[0];
  const prefix = prefixSK(walked.S_infty, k);
  const source = queryProofPreviewSource(input, walkInput.candidates);
  const preview = previewSidecar(
    input.query_proof_preview,
    k,
    previewRuntimeCapture(walked),
    source
  );
  const issuedPsi = source?.psi_v2_authority ?? issueDiagnosticPsiV2(
    input,
    walkInput.candidates
  );
  return freezeShadow({
    kind: "captured" as const,
    algorithm_id: SHADOW_ALGORITHM_ID,
    version: SHADOW_ALGORITHM_VERSION,
    digest: CAPTURE_IDENTITY_DIGEST,
    cutover_seam: shadowCutoverSeam(cutoverActivationOf(input)),
    lexical_mapping: input.observationField === undefined
      ? liveLexicalMapping(observations, input.memoryLexicalCaptures ?? [])
      : "planted" as const,
    admitted_lineages: SHADOW_LINEAGE_IDS,
    relational_o: "excluded" as const,
    eligible_keys: Object.freeze([...eligible]),
    field_membership: freezeShadow({
      e0_keys: Object.freeze([...(input.e0Keys ?? input.candidates.map(
        buildRecallCandidateDedupeKey
      ))]),
      e1_keys: Object.freeze([...(input.e1Keys ?? input.candidates.map(
        buildRecallCandidateDedupeKey
      ))])
    }),
    observations_by_candidate_key: observations,
    set_utilities: Object.freeze(input.candidates.map((candidate) => {
      const key = buildRecallCandidateDedupeKey(candidate);
      return utilityForCandidate(input, key, buildRecallLogicalObjectKey(candidate));
    })),
    frontiers,
    S_infty: walked.S_infty,
    prefix_proposal: prefix,
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
    ),
    psi_v2_shadow: observePsiV2Shadow(input, issuedPsi),
    ...preview,
    delivery_pack: observeTargetDeliveryPack({
      preview,
      snapshot_digest: input.snapshot_digest,
      capture_identity_digest: CAPTURE_IDENTITY_DIGEST
    })
  });
}

function queryProofPreviewSource(
  input: ShadowIntegrateInput,
  walkCandidates: readonly ShadowCaptureWalkCandidate[]
): QueryProofPreviewSource | undefined {
  if (input.query_proof_authority === undefined) return undefined;
  const support = input.support_measurement_authority;
  if (support === undefined) {
    return Object.freeze({
      live_authority: input.query_proof_authority,
      unsupported_reason: "support_osf_source_unavailable"
    });
  }
  const psiV2Authority = issueObservationBackedPsiV2({
    live_authority: input.query_proof_authority,
    walk_candidates: walkCandidates,
    snapshot_digest: input.snapshot_digest,
    query_id: input.query_id,
    lexical_interval_by_key: input.lexicalIntervalEnvelopesByKey,
    lexical_measurement_authority: input.lexical_measurement_authority,
    support: input.supportMaterialization,
    support_measurement_authority: support,
    producer_outcomes: input.psi_v2_producer_outcomes
  });
  if (psiV2Authority === undefined) {
    return Object.freeze({
      live_authority: input.query_proof_authority,
      support_measurement_authority: support,
      unsupported_reason: "observation_backed_psi_v2_unavailable"
    });
  }
  return Object.freeze({
    live_authority: input.query_proof_authority,
    support_measurement_authority: support,
    psi_v2_authority: psiV2Authority
  });
}

function previewRuntimeCapture(
  walked: ShadowCapturedWalk
): QueryProofPreviewRuntimeCapture {
  return Object.freeze({ walk: walked });
}

function issueDiagnosticPsiV2(
  input: ShadowIntegrateInput,
  walkCandidates: readonly ShadowCaptureWalkCandidate[]
) {
  if (input.query_proof_authority === undefined) return undefined;
  return issueObservationBackedPsiV2({
    live_authority: input.query_proof_authority,
    walk_candidates: walkCandidates,
    snapshot_digest: input.snapshot_digest,
    query_id: input.query_id,
    lexical_interval_by_key: input.lexicalIntervalEnvelopesByKey,
    lexical_measurement_authority: input.lexical_measurement_authority,
    support: input.supportMaterialization,
    support_measurement_authority: input.support_measurement_authority,
    producer_outcomes: input.psi_v2_producer_outcomes
  });
}

function observePsiV2Shadow(
  input: ShadowIntegrateInput,
  issuedArtifact: QueryProofPreviewSource["psi_v2_authority"]
): PsiV2ShadowSidecar {
  try {
    return buildPsiV2ShadowDiagnostics({
      query_id: input.query_id,
      snapshot_digest: input.snapshot_digest,
      candidate_keys: keysOf(input),
      lexical_interval_by_key: input.lexicalIntervalEnvelopesByKey,
      lexical_measurement_authority: input.lexical_measurement_authority,
      support: input.supportMaterialization,
      support_measurement_authority: input.support_measurement_authority,
      producer_outcomes: input.psi_v2_producer_outcomes,
      ...(issuedArtifact === undefined ? {} : { issued_artifact: issuedArtifact })
    });
  } catch {
    return malformedPsiV2ShadowDiagnostics();
  }
}

function keysOf(input: ShadowIntegrateInput): readonly string[] {
  return input.candidates.map(buildRecallCandidateDedupeKey);
}

export function failClosedShadowTrace(
  reason: ShadowFailClosedReason,
  activation: ShadowCutoverSeam["activation"] = "inactive"
): ShadowFailClosedTrace {
  return freezeShadow({
    kind: "fail_closed" as const,
    reason,
    algorithm_id: SHADOW_ALGORITHM_ID,
    version: SHADOW_ALGORITHM_VERSION,
    digest: CAPTURE_IDENTITY_DIGEST,
    cutover_seam: shadowCutoverSeam(activation)
  });
}

function failClosed(
  reason: ShadowFailClosedReason,
  activation: ShadowCutoverSeam["activation"] = "inactive"
): ShadowFailClosedTrace {
  return failClosedShadowTrace(reason, activation);
}

function cutoverActivationOf(input: ShadowIntegrateInput): ShadowCutoverSeam["activation"] {
  return input.cutoverActivation ?? "inactive";
}
