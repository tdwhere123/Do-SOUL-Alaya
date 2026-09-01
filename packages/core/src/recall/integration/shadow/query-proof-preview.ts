import { digestDecisionContract } from
  "../../decision/query-proof/seal/contract.js";
import { createQueryCompiledWalkTransfer } from
  "../../decision/query-proof/gamma/walk-binding.js";
import {
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "../../decision/query-proof/seal/decide.js";
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
  kMax: number
): { readonly query_proof_preview?: QueryProofPreviewSidecar } {
  if (preview === undefined) return {};
  try {
    const decided = runQueryProofDecideQ(preview.world, preview.k_max ?? kMax);
    return {
      query_proof_preview: Object.freeze({
        status: "captured" as const,
        S_infty: decided.walk.S_infty,
        prefix: decided.prefix,
        candidate_prefix: decided.trace.candidate_prefix,
        answer_bindings: decided.trace.answer_bindings,
        pick_reasons: decided.trace.pick_reasons,
        contract_digest: decided.decision_contract_digest,
        semantic_feasibility: preview.world.compiled.semantic_feasibility,
        resource_policy: preview.world.compiled.resource_policy
      })
    };
  } catch (error) {
    try {
      return failedSidecar(previewContractDigest(preview.world), error);
    } catch {
      return failedSidecar("sha256:preview_unavailable", error);
    }
  }
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
