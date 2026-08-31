import {
  isCapturedWalk,
  walkShadowCapture,
  type ShadowWalkUtilityTransfer
} from "../../decision/prefix-capture/walk.js";

export type QueryProofPreviewSidecar = Readonly<{
  readonly status: "captured" | "failed";
  readonly S_infty: readonly string[];
  readonly contract_digest: string;
  readonly reason?: string;
}>;

export function previewSidecar(
  preview: Readonly<{ readonly utility_transfer: ShadowWalkUtilityTransfer }> | undefined,
  walkInput: Parameters<typeof walkShadowCapture>[0]
): { readonly query_proof_preview?: QueryProofPreviewSidecar } {
  if (preview === undefined) return {};
  try {
    const walked = walkShadowCapture({
      ...walkInput,
      utility_transfer: preview.utility_transfer
    });
    if (!isCapturedWalk(walked)) {
      return failedPreview(digestOf(preview), "preview walk was not captured");
    }
    return {
      query_proof_preview: Object.freeze({
        status: "captured" as const,
        S_infty: walked.S_infty,
        contract_digest: digestOf(preview)
      })
    };
  } catch (error) {
    return failedPreview(
      digestOf(preview),
      error instanceof Error ? error.message : "preview failed"
    );
  }
}

function failedPreview(
  contractDigest: string,
  reason: string
): { readonly query_proof_preview: QueryProofPreviewSidecar } {
  return {
    query_proof_preview: Object.freeze({
      status: "failed" as const,
      S_infty: Object.freeze([] as string[]),
      contract_digest: contractDigest,
      reason
    })
  };
}

function digestOf(
  preview: Readonly<{ readonly utility_transfer?: { readonly contract_digest?: unknown } }>
): string {
  const digest = preview.utility_transfer?.contract_digest;
  return typeof digest === "string" ? digest : "sha256:preview_unavailable";
}
