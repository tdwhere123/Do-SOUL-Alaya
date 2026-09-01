import { digestDecisionContract } from
  "../../decision/query-proof/seal/contract.js";
import { createQueryCompiledWalkTransfer } from
  "../../decision/query-proof/gamma/walk-binding.js";
import {
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
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

export type QueryProofPreviewRuntimeCapture = QueryProofDecideRuntimeManifestV1;

export type QueryProofPreviewSource = Readonly<{
  readonly live_authority: LiveQueryProofAuthority;
  readonly support_measurement_authority: VerifiedMeasurementAuthorityV1;
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
  runtimeCapture?: QueryProofPreviewRuntimeCapture,
  source?: QueryProofPreviewSource
): { readonly query_proof_preview?: QueryProofPreviewSidecar } {
  if (preview === undefined && source === undefined) return {};
  const capturedKMax = source === undefined ? preview?.k_max ?? kMax : kMax;
  let rawWorld: QueryProofDecideWorldV1;
  try {
    if (source !== undefined) {
      if (runtimeCapture === undefined) {
        throw new Error("source-owned query-proof preview requires the exact live walk");
      }
      rawWorld = captureSourceOwnedQueryProofDecideWorld({
        live_authority: source.live_authority,
        support_measurement_authority: source.support_measurement_authority,
        walk: runtimeCapture.walk
      });
    } else {
      rawWorld = preview!.world;
    }
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
