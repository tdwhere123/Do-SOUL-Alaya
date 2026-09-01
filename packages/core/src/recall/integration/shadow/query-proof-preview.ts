import { digestDecisionContract } from
  "../../decision/query-proof/seal/contract.js";
import { createQueryCompiledWalkTransfer } from
  "../../decision/query-proof/gamma/walk-binding.js";
import {
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "../../decision/query-proof/seal/decide.js";
import {
  bindQueryProofDecideWorldToRuntimeCapture,
  decideWorldCapture,
  freezeDecideWorld
} from "../../decision/query-proof/seal/world-capture.js";
import { digestRecallFieldIdentity } from
  "../../field/field-identity.js";
import { compareText } from "../../../shared/compare-text.js";
import type { FiniteDecisionTraceInput } from
  "../../decision/query-proof/proof/oracle/contract.js";
import {
  DEFAULT_RESOURCE_FEASIBILITY_POLICY,
  type QueryGammaCandidateFeasibilityV1,
  type ResourceFeasibilityPolicyV1
} from "../../decision/query-proof/gamma/contract.js";

export type QueryProofPreviewRequest = Readonly<{
  readonly world: QueryProofDecideWorldV1;
  readonly k_max?: number;
}>;

export type QueryProofPreviewRuntimeCapture = Readonly<{
  readonly candidates: QueryProofDecideWorldV1["candidates"];
  readonly psi_edges: QueryProofDecideWorldV1["psi_edges"];
  readonly token_budget: number;
  readonly per_dimension_limits: QueryProofDecideWorldV1["per_dimension_limits"];
  readonly unresolved_tradeoff_pairs:
    QueryProofDecideWorldV1["unresolved_tradeoff_pairs"];
}>;

export type QueryProofPreviewSidecar = Readonly<{
  readonly status: "captured" | "failed";
  readonly S_infty: readonly string[];
  readonly prefix: readonly string[];
  readonly candidate_prefix: readonly string[];
  readonly answer_bindings: FiniteDecisionTraceInput["answer_bindings"];
  readonly pick_reasons: FiniteDecisionTraceInput["pick_reasons"];
  readonly contract_digest: string;
  readonly semantic_feasibility: readonly QueryGammaCandidateFeasibilityV1[];
  readonly resource_policy: ResourceFeasibilityPolicyV1;
  readonly reason?: string;
}>;

export function previewSidecar(
  preview: QueryProofPreviewRequest | undefined,
  kMax: number,
  runtimeCapture?: QueryProofPreviewRuntimeCapture
): { readonly query_proof_preview?: QueryProofPreviewSidecar } {
  if (preview === undefined) return {};
  const capturedKMax = preview.k_max ?? kMax;
  let rawWorld: QueryProofDecideWorldV1;
  try {
    rawWorld = preview.world;
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
    const manifestDigest = assertRuntimeCaptureMatches(capturedWorld, runtimeCapture);
    bindQueryProofDecideWorldToRuntimeCapture(capturedWorld, manifestDigest);
  } catch (error) {
    return failedSidecar("sha256:preview_unavailable", error);
  }
  try {
    const decided = runQueryProofDecideQ(capturedWorld, capturedKMax);
    return {
      query_proof_preview: Object.freeze({
        status: "captured" as const,
        S_infty: decided.walk.S_infty,
        prefix: decided.prefix,
        candidate_prefix: decided.trace.candidate_prefix,
        answer_bindings: decided.trace.answer_bindings,
        pick_reasons: decided.trace.pick_reasons,
        contract_digest: decided.decision_contract_digest,
        semantic_feasibility: capturedWorld.compiled.semantic_feasibility,
        resource_policy: capturedWorld.compiled.resource_policy
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

function assertRuntimeCaptureMatches(
  world: QueryProofDecideWorldV1,
  runtime: QueryProofPreviewRuntimeCapture
): ReturnType<typeof digestRecallFieldIdentity> {
  const worldCandidates = candidateManifest(world.candidates);
  const runtimeCandidates = candidateManifest(runtime.candidates);
  const evidenceKeys = [...world.compile_input.candidates.map((row) => row.candidate_key)]
    .sort(compareText);
  const runtimeKeys = [...runtime.candidates.map((row) => row.candidate_key)]
    .sort(compareText);
  if (digestRecallFieldIdentity(worldCandidates) !== digestRecallFieldIdentity(runtimeCandidates) ||
      digestRecallFieldIdentity(evidenceKeys) !== digestRecallFieldIdentity(runtimeKeys) ||
      world.token_budget !== runtime.token_budget ||
      digestRecallFieldIdentity(world.per_dimension_limits) !==
        digestRecallFieldIdentity(runtime.per_dimension_limits) ||
      digestRecallFieldIdentity(normalizedPairs(world.psi_edges, true)) !==
        digestRecallFieldIdentity(normalizedPairs(runtime.psi_edges, true)) ||
      digestRecallFieldIdentity(normalizedPairs(world.unresolved_tradeoff_pairs, false)) !==
        digestRecallFieldIdentity(normalizedPairs(runtime.unresolved_tradeoff_pairs, false))) {
    throw new Error("Decide_Q world does not match the exact live runtime capture");
  }
  return digestRecallFieldIdentity({
    kind: "query_proof_runtime_capture_v1",
    candidates: runtimeCandidates,
    psi_edges: normalizedPairs(runtime.psi_edges, true),
    token_budget: runtime.token_budget,
    per_dimension_limits: runtime.per_dimension_limits,
    unresolved_tradeoff_pairs: normalizedPairs(runtime.unresolved_tradeoff_pairs, false)
  });
}

function candidateManifest(
  candidates: QueryProofDecideWorldV1["candidates"]
): readonly object[] {
  return Object.freeze(candidates.map((row) => Object.freeze({
    candidate_key: row.candidate_key,
    object_key: row.object_key,
    token_cost: row.token_cost,
    dimension: row.dimension,
    h_eligible: row.h_eligible,
    static_frontier_index: row.static_frontier_index
  })).sort((left, right) => compareText(left.candidate_key, right.candidate_key)));
}

function normalizedPairs(
  pairs: readonly (readonly [string, string])[],
  directed: boolean
): readonly (readonly [string, string])[] {
  return Object.freeze(pairs.map(([left, right]) => {
    if (directed || compareText(left, right) <= 0) return Object.freeze([left, right] as const);
    return Object.freeze([right, left] as const);
  }).sort((left, right) => compareText(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`)));
}

function failedSidecar(
  contractDigest: string,
  error: unknown
): { readonly query_proof_preview: QueryProofPreviewSidecar } {
  return {
    query_proof_preview: Object.freeze({
      status: "failed" as const,
      S_infty: Object.freeze([] as string[]),
      prefix: Object.freeze([] as string[]),
      candidate_prefix: Object.freeze([] as string[]),
      answer_bindings: Object.freeze([] as FiniteDecisionTraceInput["answer_bindings"]),
      pick_reasons: Object.freeze([] as FiniteDecisionTraceInput["pick_reasons"]),
      contract_digest: contractDigest,
      semantic_feasibility: Object.freeze([] as QueryGammaCandidateFeasibilityV1[]),
      resource_policy: DEFAULT_RESOURCE_FEASIBILITY_POLICY,
      reason: error instanceof Error ? error.message : "preview failed"
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
