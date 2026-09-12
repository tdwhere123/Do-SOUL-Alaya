import type { LocalOnnxEmbeddingTransformersModule } from "./local-onnx-embedding-client.js";

// Optional extra, not a package.json dependency: this workspace's
// autoInstallPeers would otherwise pull ~640MiB ONNX (including ORT-web)
// on every default install. Non-literal specifier so typecheck stays green
// without the extra.
const TRANSFORMERS_PACKAGE: string = "@huggingface/transformers";

export async function importLocalOnnxTransformers(): Promise<LocalOnnxEmbeddingTransformersModule> {
  try {
    return (await import(TRANSFORMERS_PACKAGE)) as LocalOnnxEmbeddingTransformersModule;
  } catch (error) {
    // Packaging miss, not an unreadable model artifact.
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "@huggingface/transformers is required for the local ONNX embedding provider. Install the optional extra: pnpm add @huggingface/transformers --filter @do-soul/alaya-core",
        { cause: error }
      );
    }
    throw error;
  }
}
