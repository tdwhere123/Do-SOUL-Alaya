import { digestDecisionContract } from
  "../../decision/query-proof/seal/contract.js";
import { createQueryCompiledWalkTransfer } from
  "../../decision/query-proof/gamma/walk-binding.js";
import {
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1,
  type QueryProofPackModeV1
} from "../../decision/query-proof/seal/decide.js";
import {
  captureQueryProofDecideRuntime,
  captureSourceOwnedQueryProofDecideWorld,
  decideWorldCapture,
  freezeDecideWorld,
  type QueryProofDecideRuntimeManifestV1
} from "../../decision/query-proof/seal/world-capture.js";
import type { LiveQueryProofAuthority } from
  "../../decision/query-proof/live-query-proof-authority.js";
import type { VerifiedMeasurementAuthorityV1 } from
  "../../decision/query-proof/measurement/admission.js";
import {
  issuePsiV2AuthorityArtifact,
  type PsiV2AuthorityArtifactV1,
  type PsiV2IssuedProducerOutcomeV1
} from "../../decision/query-proof/dominance/authority.js";
import { psiV2CandidateFromLexicalEnvelope } from
  "../../decision/query-proof/dominance/from-envelope.js";
import { psiV2CandidatesFromSupport } from
  "../../decision/query-proof/dominance/support-measurement-adapter.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from
  "../../decision/query-proof/dominance/types.js";
import type { PsiV2ProducerOutcomeV1, PsiV2ShadowInputV1 } from
  "../../decision/query-proof/dominance/shadow-diagnostics.js";
import type { FiniteDecisionTraceInput } from
  "../../decision/query-proof/proof/oracle/contract.js";
import {
  DEFAULT_RESOURCE_FEASIBILITY_POLICY,
  type QueryGammaCandidateFeasibilityV1,
  type QueryGammaCompileDispositionV1,
  type ResourceFeasibilityPolicyV1
} from "../../decision/query-proof/gamma/contract.js";
import type {
  ShadowCapturedWalk,
  ShadowCaptureWalkCandidate
} from "../../decision/prefix-capture/walk.js";
import { CAPTURE_IDENTITY_DIGEST } from
  "../../decision/prefix-capture/identity.js";
import { buildShadowDeliveryPack } from
  "../../decision/query-proof/delivery/pack.js";
import type { DeliveryPackV1 } from
  "../../decision/query-proof/delivery/contract.js";
import { compareText } from "../../../shared/compare-text.js";

export type QueryProofPreviewRequest = Readonly<{
  readonly world: QueryProofDecideWorldV1;
  readonly k_max?: number;
}>;

export type QueryProofPreviewRuntimeCapture = QueryProofDecideRuntimeManifestV1;

export type QueryProofPreviewSource = Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly support_measurement_authority?: VerifiedMeasurementAuthorityV1;
  readonly psi_v2_authority?: PsiV2AuthorityArtifactV1;
  readonly unsupported_reason?: string;
}>;

export type QueryProofCandidateDispositionKindV1 =
  | "not_in_field"
  | "in_field_unavailable_before_psi"
  | "dominated"
  | "incomparable"
  | "uncertain"
  | "cycle"
  | "gamma_infeasible"
  | "gamma_unresolved"
  | "gamma_zero"
  | "gamma_positive_by_stratum"
  | "resource_rejected"
  | "selected_within_top5"
  | "selected_after_top5";

export type QueryProofCandidateDispositionV1 = Readonly<{
  readonly candidate_key: string;
  readonly disposition: QueryProofCandidateDispositionKindV1;
}>;

export type QueryProofRejectReasonV1 = Readonly<{
  readonly candidate_key: string;
  readonly reason: string;
}>;

export type QueryProofPreviewSidecar = Readonly<{
  readonly status: "captured" | "failed";
  readonly S_infty: readonly string[];
  readonly prefix: readonly string[];
  readonly candidate_prefix: readonly string[];
  readonly answer_bindings: FiniteDecisionTraceInput["answer_bindings"];
  readonly pick_reasons: FiniteDecisionTraceInput["pick_reasons"];
  readonly reject_reasons: readonly QueryProofRejectReasonV1[];
  readonly contract_digest: string;
  readonly semantic_feasibility: readonly QueryGammaCandidateFeasibilityV1[];
  readonly resource_policy: ResourceFeasibilityPolicyV1;
  readonly reason?: string;
  readonly pack_mode?: QueryProofPackModeV1;
  readonly compile_disposition?: QueryGammaCompileDispositionV1;
  readonly query_digest?: string;
  readonly decision_identity_digest?: string;
  readonly first_frontier_size: number | null;
  readonly frontier_depth: number | null;
  readonly candidate_dispositions: readonly QueryProofCandidateDispositionV1[];
}>;

export type ObservationBackedPsiIssueInput = Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly walk_candidates: readonly ShadowCaptureWalkCandidate[];
  readonly snapshot_digest?: string;
  readonly query_id?: string;
  readonly lexical_interval_by_key?: PsiV2ShadowInputV1["lexical_interval_by_key"];
  readonly lexical_measurement_authority?: VerifiedMeasurementAuthorityV1;
  readonly support?: PsiV2ShadowInputV1["support"];
  readonly support_measurement_authority?: VerifiedMeasurementAuthorityV1;
  readonly producer_outcomes?: readonly PsiV2ProducerOutcomeV1[];
}>;

export function previewSidecar(
  preview: QueryProofPreviewRequest | undefined,
  kMax: number,
  runtimeCapture?: QueryProofPreviewRuntimeCapture,
  source?: QueryProofPreviewSource
): { readonly query_proof_preview?: QueryProofPreviewSidecar } {
  if (preview === undefined && source === undefined) return {};
  const capturedKMax = source === undefined ? preview?.k_max ?? kMax : kMax;
  let rawWorld: QueryProofDecideWorldV1;
  try {
    rawWorld = sourceOwnedOrInjectedWorld(source, preview, runtimeCapture);
  } catch (error) {
    return failedSidecar("sha256:preview_unavailable", error);
  }
  let capturedWorld: QueryProofDecideWorldV1;
  try {
    capturedWorld = freezeDecideWorld(rawWorld);
    if (decideWorldCapture(capturedWorld) === null) {
      throw new Error("query-proof preview requires a verified captured Decide_Q world");
    }
    if (runtimeCapture === undefined) {
      throw new Error("query-proof preview requires the exact live runtime capture");
    }
    captureQueryProofDecideRuntime(capturedWorld, runtimeCapture);
  } catch (error) {
    return failedSidecar("sha256:preview_unavailable", error);
  }
  try {
    const decided = runQueryProofDecideQ(capturedWorld, capturedKMax);
    const artifact = source?.psi_v2_authority;
    return {
      query_proof_preview: Object.freeze({
        status: "captured" as const,
        S_infty: decided.walk.S_infty,
        prefix: decided.prefix,
        candidate_prefix: decided.trace.candidate_prefix,
        answer_bindings: decided.trace.answer_bindings,
        pick_reasons: decided.trace.pick_reasons,
        reject_reasons: rejectReasonsOf(decided.walk),
        contract_digest: decided.decision_contract_digest,
        semantic_feasibility: capturedWorld.compiled.semantic_feasibility,
        resource_policy: capturedWorld.compiled.resource_policy,
        pack_mode: shadowEmittedPackMode(decided.pack_mode),
        compile_disposition: capturedWorld.compiled.compile_disposition,
        query_digest: capturedWorld.compiled.query_digest,
        decision_identity_digest: decided.decision_identity_digest,
        first_frontier_size: artifact?.first_frontier_size ?? null,
        frontier_depth: artifact?.frontier_depth ?? null,
        candidate_dispositions: projectTargetCandidateDispositions({
          candidates: capturedWorld.candidates,
          feasibility: capturedWorld.compiled.semantic_feasibility,
          psi_edges: capturedWorld.psi_edges,
          artifact,
          walk: decided.walk
        })
      })
    };
  } catch (error) {
    try {
      return failedSidecar(previewContractDigest(capturedWorld), error);
    } catch {
      return failedSidecar("sha256:preview_unavailable", error);
    }
  }
}

function sourceOwnedOrInjectedWorld(
  source: QueryProofPreviewSource | undefined,
  preview: QueryProofPreviewRequest | undefined,
  runtimeCapture: QueryProofPreviewRuntimeCapture | undefined
): QueryProofDecideWorldV1 {
  if (source === undefined) return preview!.world;
  if (source.support_measurement_authority === undefined) {
    throw new Error(source.unsupported_reason ?? "support_osf_source_unavailable");
  }
  if (source.psi_v2_authority === undefined) {
    // World-capture would re-issue a skeleton Psi; fail instead of a fake complete artifact.
    throw new Error(source.unsupported_reason ?? "observation_backed_psi_v2_unavailable");
  }
  if (runtimeCapture === undefined) {
    throw new Error("source-owned query-proof preview requires the exact live walk");
  }
  return captureSourceOwnedQueryProofDecideWorld({
    live_authority: source.live_authority,
    support_measurement_authority: source.support_measurement_authority,
    walk: runtimeCapture.walk,
    psi_v2_authority: source.psi_v2_authority
  });
}

export function issueObservationBackedPsiV2(
  input: ObservationBackedPsiIssueInput
): PsiV2AuthorityArtifactV1 | undefined {
  if (!canIssueObservationBackedPsi(input)) return undefined;
  const keys = Object.freeze(input.walk_candidates.map((row) => row.candidate_key));
  const outcomes = producerOutcomesOf(input);
  const snapshotDigest = input.snapshot_digest ??
    input.live_authority.snapshot_vector.vector_digest;
  const queryDigest = input.query_id ??
    input.live_authority.canonical_query_compilation.query_identity.condition_identity;
  const authorities = Object.freeze([
    input.lexical_measurement_authority,
    input.support_measurement_authority
  ].filter((row): row is VerifiedMeasurementAuthorityV1 => row !== undefined));
  try {
    return issuePsiV2AuthorityArtifact({
      query_digest: queryDigest,
      snapshot_digest: snapshotDigest,
      workspace_id: input.live_authority.workspace_id,
      generation: input.live_authority.canonical_query_compilation.query_identity.generation_id,
      source_authority_digests: authorities.map((row) => row.authority_digest),
      candidates: observationCandidates(input, keys, outcomes, queryDigest, snapshotDigest),
      candidate_objects: input.walk_candidates.map((row) => ({
        candidate_key: row.candidate_key,
        object_key: row.object_key,
        h_eligible: row.h_eligible,
        h_eligibility_source: "live_walk_runtime_manifest"
      })),
      current_authorities: authorities,
      producer_outcomes: issuedProducerOutcomes(outcomes),
      observation_status: "observed"
    });
  } catch {
    return undefined;
  }
}

export function observeTargetDeliveryPack(params: Readonly<{
  readonly preview: { readonly query_proof_preview?: QueryProofPreviewSidecar };
  readonly snapshot_digest?: string;
  readonly capture_identity_digest?: string;
}>): DeliveryPackV1 {
  const sidecar = params.preview.query_proof_preview;
  const sidecarIdentity = sidecar?.status === "captured"
    ? sidecar.decision_identity_digest
    : undefined;
  const captureIdentity = sidecarIdentity ??
    params.capture_identity_digest ??
    CAPTURE_IDENTITY_DIGEST;
  try {
    if (sidecar === undefined || sidecar.status !== "captured") {
      return unsupportedTargetPack(captureIdentity);
    }
    return buildShadowDeliveryPack({
      selected_candidates: sidecar.prefix,
      capture_identity_digest: captureIdentity,
      preview_status: sidecar.status,
      preview_bindings: sidecar.answer_bindings,
      preview_contract_digest: sidecar.contract_digest,
      snapshot_digest: params.snapshot_digest,
      query_digest: sidecar.query_digest,
      mode: shadowEmittedPackMode(sidecar.pack_mode),
      ...(sidecarIdentity === undefined ? {} : { decision_identity_digest: sidecarIdentity })
    });
  } catch {
    return unsupportedTargetPack(captureIdentity);
  }
}

function shadowEmittedPackMode(
  mode: QueryProofPackModeV1 | undefined
): QueryProofPackModeV1 {
  if (mode === "certified") return "best_effort_uncertified";
  return mode ?? "unsupported";
}

function unsupportedTargetPack(captureIdentity: string): DeliveryPackV1 {
  return buildShadowDeliveryPack({
    selected_candidates: Object.freeze([] as string[]),
    capture_identity_digest: captureIdentity,
    preview_status: "failed",
    mode: "unsupported"
  });
}

function failedSidecar(
  contractDigest: string,
  error: unknown
): { readonly query_proof_preview: QueryProofPreviewSidecar } {
  const reason = error instanceof Error ? error.message : "preview failed";
  return {
    query_proof_preview: Object.freeze({
      status: "failed" as const,
      S_infty: Object.freeze([] as string[]),
      prefix: Object.freeze([] as string[]),
      candidate_prefix: Object.freeze([] as string[]),
      answer_bindings: Object.freeze([] as FiniteDecisionTraceInput["answer_bindings"]),
      pick_reasons: Object.freeze([] as FiniteDecisionTraceInput["pick_reasons"]),
      reject_reasons: Object.freeze([] as QueryProofRejectReasonV1[]),
      contract_digest: contractDigest,
      semantic_feasibility: Object.freeze([] as QueryGammaCandidateFeasibilityV1[]),
      resource_policy: DEFAULT_RESOURCE_FEASIBILITY_POLICY,
      reason,
      pack_mode: "unsupported" as const,
      first_frontier_size: null,
      frontier_depth: null,
      candidate_dispositions: Object.freeze([] as QueryProofCandidateDispositionV1[])
    })
  };
}

function previewContractDigest(world: QueryProofDecideWorldV1): string {
  try {
    const transfer = createQueryCompiledWalkTransfer(world.compiled);
    return digestDecisionContract(world.compiled, transfer.contract_digest);
  } catch {
    return "sha256:preview_unavailable";
  }
}

function canIssueObservationBackedPsi(input: ObservationBackedPsiIssueInput): boolean {
  const outcomes = producerOutcomesOf(input);
  const support = outcomeOf(outcomes, "support");
  if (support?.status === "malformed") return false;
  const supportObserved = producerObserved(outcomes, "support") && input.support !== undefined;
  const lexicalObserved = producerObserved(outcomes, "lex.interval") &&
    input.lexical_interval_by_key !== undefined;
  return supportObserved || lexicalObserved;
}

function observationCandidates(
  input: ObservationBackedPsiIssueInput,
  keys: readonly string[],
  outcomes: readonly PsiV2ProducerOutcomeV1[],
  queryDigest: string,
  snapshotDigest: string
): readonly PsiV2CandidateV1[] {
  const maps = input.lexical_interval_by_key;
  const lexical = !producerObserved(outcomes, "lex.interval") || maps === undefined
    ? []
    : keys.map((key) => psiV2CandidateFromLexicalEnvelope(
      key,
      maps[key],
      input.lexical_measurement_authority ?? queryDigest,
      snapshotDigest
    ));
  const support = !producerObserved(outcomes, "support") || input.support === undefined
    ? []
    : psiV2CandidatesFromSupport({
      candidate_keys: keys,
      support: input.support,
      measurement_authority: input.support_measurement_authority
    });
  return mergePsiCandidates(keys, lexical, support);
}

function mergePsiCandidates(
  keys: readonly string[],
  ...fields: readonly (readonly PsiV2CandidateV1[])[]
): readonly PsiV2CandidateV1[] {
  const byCandidate = new Map(keys.map((key) => [key, new Map<string, PsiV2CoordinateV1>()]));
  for (const field of fields) {
    for (const candidate of field) {
      const coordinates = byCandidate.get(candidate.candidate_id);
      if (coordinates === undefined) continue;
      for (const coordinate of candidate.coordinates) {
        coordinates.set(coordinate.proposition_id, coordinate);
      }
    }
  }
  return Object.freeze([...byCandidate].map(([candidateId, coordinates]) => Object.freeze({
    candidate_id: candidateId,
    coordinates: Object.freeze([...coordinates.values()].sort((left, right) =>
      compareText(left.proposition_id, right.proposition_id)))
  })));
}

function producerOutcomesOf(
  input: ObservationBackedPsiIssueInput
): readonly PsiV2ProducerOutcomeV1[] {
  if (input.producer_outcomes !== undefined) return input.producer_outcomes;
  return Object.freeze([
    inferredProducer(input, "lex.interval"),
    inferredProducer(input, "support")
  ]);
}

function inferredProducer(
  input: ObservationBackedPsiIssueInput,
  producerId: "lex.interval" | "support"
): PsiV2ProducerOutcomeV1 {
  const authority = producerId === "lex.interval"
    ? input.lexical_measurement_authority
    : input.support_measurement_authority;
  if (authority === undefined) {
    return Object.freeze({
      producer_id: producerId,
      status: "producer_unavailable" as const,
      reason: "authority_unavailable" as const
    });
  }
  const payloadPresent = producerId === "lex.interval"
    ? input.lexical_interval_by_key !== undefined
    : input.support !== undefined;
  return payloadPresent
    ? Object.freeze({ producer_id: producerId, status: "observed" as const })
    : Object.freeze({
      producer_id: producerId,
      status: "not_observed" as const,
      reason: "input_absent" as const
    });
}

function producerObserved(
  outcomes: readonly PsiV2ProducerOutcomeV1[],
  producerId: "lex.interval" | "support"
): boolean {
  return outcomes.some((row) => row.producer_id === producerId && row.status === "observed");
}

function outcomeOf(
  outcomes: readonly PsiV2ProducerOutcomeV1[],
  producerId: "lex.interval" | "support"
): PsiV2ProducerOutcomeV1 | undefined {
  return outcomes.find((row) => row.producer_id === producerId);
}

function issuedProducerOutcomes(
  outcomes: readonly PsiV2ProducerOutcomeV1[]
): readonly PsiV2IssuedProducerOutcomeV1[] {
  return Object.freeze(outcomes.map((row) => Object.freeze({
    producer_id: row.producer_id,
    status: row.status,
    ...("reason" in row && row.reason !== undefined ? { reason: row.reason } : {}),
    ...("contract_code" in row && row.contract_code !== undefined
      ? { contract_code: row.contract_code }
      : {})
  })));
}

const TOP5 = 5;

export type TargetChainDispositionInput = Readonly<{
  readonly candidates: readonly ShadowCaptureWalkCandidate[];
  readonly feasibility: readonly QueryGammaCandidateFeasibilityV1[];
  readonly psi_edges: readonly (readonly [string, string])[];
  readonly artifact?: PsiV2AuthorityArtifactV1;
  readonly walk: ShadowCapturedWalk;
}>;

export function projectTargetCandidateDispositions(
  input: TargetChainDispositionInput
): readonly QueryProofCandidateDispositionV1[] {
  const field = new Set(input.candidates.map((row) => row.candidate_key));
  const byKey = new Map(input.candidates.map((row) => [row.candidate_key, row]));
  const semantic = new Map(input.feasibility.map((row) => [row.candidate_key, row.semantic]));
  const selectedAt = new Map(input.walk.S_infty.map((key, index) => [key, index]));
  const rejected = new Set(input.walk.walk_rejects.map((row) => row.candidate_key));
  const positive = positiveGammaKeys(input.walk);
  const zeroObserved = new Set(input.walk.decisions
    .filter((decision) => gammaTupleZero(decision.G))
    .map((decision) => decision.candidate_key));
  const dominated = dominatedKeys(input.artifact, input.psi_edges);
  const uncertain = pairKindKeys(input.artifact, ["uncertain", "tradeoff"]);
  const cycle = input.artifact?.cycle_status === "cycle";
  const keys = uniqueSorted([
    ...field,
    ...semantic.keys(),
    ...(input.artifact?.candidate_universe ?? []),
    ...input.walk.S_infty,
    ...rejected
  ]);
  return Object.freeze(keys.map((key) => Object.freeze({
    candidate_key: key,
    disposition: classifyDisposition({
      inField: field.has(key),
      unavailable: byKey.get(key)?.h_eligible === false,
      cycle,
      selectedAt: selectedAt.get(key),
      rejected: rejected.has(key),
      semantic: semantic.get(key),
      dominated: dominated.has(key),
      uncertain: uncertain.has(key),
      positive: positive.has(key),
      zeroObserved: zeroObserved.has(key)
    })
  })));
}

function classifyDisposition(row: Readonly<{
  readonly inField: boolean;
  readonly unavailable: boolean;
  readonly cycle: boolean;
  readonly selectedAt: number | undefined;
  readonly rejected: boolean;
  readonly semantic: QueryGammaCandidateFeasibilityV1["semantic"] | undefined;
  readonly dominated: boolean;
  readonly uncertain: boolean;
  readonly positive: boolean;
  readonly zeroObserved: boolean;
}>): QueryProofCandidateDispositionKindV1 {
  if (!row.inField) return "not_in_field";
  if (row.unavailable) return "in_field_unavailable_before_psi";
  if (row.cycle) return "cycle";
  if (row.selectedAt !== undefined) {
    return row.selectedAt < TOP5 ? "selected_within_top5" : "selected_after_top5";
  }
  if (row.rejected) return "resource_rejected";
  if (row.semantic === "infeasible") return "gamma_infeasible";
  if (row.semantic === "unresolved") return "gamma_unresolved";
  if (row.dominated) return "dominated";
  if (row.uncertain) return "uncertain";
  if (row.positive) return "gamma_positive_by_stratum";
  if (row.zeroObserved) return "gamma_zero";
  return "incomparable";
}

function rejectReasonsOf(walk: ShadowCapturedWalk): readonly QueryProofRejectReasonV1[] {
  return Object.freeze(walk.walk_rejects.map((row) => Object.freeze({
    candidate_key: row.candidate_key,
    reason: row.walk_reject
  })));
}

function dominatedKeys(
  artifact: PsiV2AuthorityArtifactV1 | undefined,
  psiEdges: readonly (readonly [string, string])[]
): ReadonlySet<string> {
  const dominated = new Set<string>();
  for (const [, key] of psiEdges) dominated.add(key);
  if (artifact === undefined) return dominated;
  for (const row of artifact.pair_outcomes) {
    if (row.outcome === "strict_edge") dominated.add(row.right_candidate_key);
    if (row.outcome === "reverse_edge") dominated.add(row.left_candidate_key);
  }
  return dominated;
}

function pairKindKeys(
  artifact: PsiV2AuthorityArtifactV1 | undefined,
  kinds: readonly string[]
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (artifact === undefined) return keys;
  const wanted = new Set(kinds);
  for (const row of artifact.pair_outcomes) {
    if (!wanted.has(row.outcome)) continue;
    keys.add(row.left_candidate_key);
    keys.add(row.right_candidate_key);
  }
  return keys;
}

function positiveGammaKeys(walk: ShadowCapturedWalk): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const decision of walk.decisions) {
    if (gammaTuplePositive(decision.G) && !walk.S_infty.includes(decision.candidate_key)) {
      keys.add(decision.candidate_key);
    }
    for (const row of decision.equal_g_dominance_rejects) keys.add(row.candidate_key);
    for (const key of decision.max_g_cohort) {
      if (key !== decision.candidate_key) keys.add(key);
    }
  }
  return keys;
}

function gammaTuplePositive(gamma: unknown): boolean {
  if (gamma === null || typeof gamma !== "object") return false;
  const rec = gamma as Readonly<Record<string, unknown>>;
  return ["answer_binding_position", "required_proposition_support",
    "certified_independent_support"].some((key) => {
    const value = rec[key];
    return typeof value === "number" && value > 0;
  });
}

function gammaTupleZero(gamma: unknown): boolean {
  if (gamma === null || typeof gamma !== "object") return false;
  const rec = gamma as Readonly<Record<string, unknown>>;
  const keys = ["answer_binding_position", "required_proposition_support",
    "certified_independent_support"] as const;
  return keys.every((key) => rec[key] === 0);
}

function uniqueSorted(keys: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(keys)].sort(compareText));
}
