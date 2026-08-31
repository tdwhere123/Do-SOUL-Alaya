import { LOCAL_ONNX_EMBEDDING_DIMENSIONS } from "@do-soul/alaya-core";
import { recallEvalEmbeddingMode } from
  "../../../lifecycle/recall-eval/recall-eval-runtime.js";
import { resolveEmbeddingSupplementRuntimeProvenance } from
  "../../../provenance/embedding/local-onnx.js";
import {
  bindOverlaySourceFromSnapshot,
  createProductOverlayEmbeddingProvider,
  emitEmbeddingCacheOverlay
} from "./emit.js";

export const PRODUCT_OVERLAY_UNAVAILABLE =
  "treatment recall requires a sealed embedding cache overlay; " +
  "local_onnx is unavailable (refusing per-question document encode)";

export function productOverlayAdmissionOpen(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return recallEvalEmbeddingMode(env) === "env";
}

export function isProductOverlayUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === PRODUCT_OVERLAY_UNAVAILABLE ||
    message.includes("local ONNX artifact tree is missing") ||
    message.includes("local ONNX embedding provider is unavailable");
}

export async function emitProductOverlayForSnapshot(input: {
  readonly snapshotDbPath: string;
  readonly receiptPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  readonly memory_embedding_count: number;
  readonly evidence_embedding_count: number;
}> {
  const env = input.env ?? process.env;
  if (!productOverlayAdmissionOpen(env)) {
    throw new Error(PRODUCT_OVERLAY_UNAVAILABLE);
  }
  const provider = createProductOverlayEmbeddingProvider(env);
  try {
    return await emitWithProductProvider(input, provider, env);
  } finally {
    await provider.close();
  }
}

async function emitWithProductProvider(
  input: {
    readonly snapshotDbPath: string;
    readonly receiptPath: string;
  },
  provider: ReturnType<typeof createProductOverlayEmbeddingProvider>,
  env: Readonly<Record<string, string | undefined>>
): Promise<{
  readonly memory_embedding_count: number;
  readonly evidence_embedding_count: number;
}> {
  const supplement = await resolveEmbeddingSupplementRuntimeProvenance(
    "env",
    "local_onnx",
    env
  );
  if (!supplement.enabled || supplement.provider_kind !== "local_onnx") {
    throw new Error(PRODUCT_OVERLAY_UNAVAILABLE);
  }
  const source = await bindOverlaySourceFromSnapshot({
    snapshotDbPath: input.snapshotDbPath,
    provider,
    dimensions: LOCAL_ONNX_EMBEDDING_DIMENSIONS,
    modelArtifactSha256: supplement.model_artifact_sha256
  });
  const binding = await emitEmbeddingCacheOverlay({
    snapshotDbPath: input.snapshotDbPath,
    receiptPath: input.receiptPath,
    provider,
    source
  });
  if (binding.memory_embedding_count + binding.evidence_embedding_count === 0) {
    throw new Error("embedding cache overlay emit produced no vectors");
  }
  return binding;
}
