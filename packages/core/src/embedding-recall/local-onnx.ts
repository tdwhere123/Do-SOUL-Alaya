import { createRequire } from "node:module";
import type { LocalOnnxEmbeddingTransformersModule } from "./local-onnx-embedding-client.js";

// Optional extra, not a package.json dependency: this workspace's
// autoInstallPeers would otherwise pull ~640MiB ONNX (including ORT-web)
// on every default install. Non-literal specifier so typecheck stays green
// without the extra.
const TRANSFORMERS_PACKAGE: string = "@huggingface/transformers";

export type LocalOnnxTransformersAvailability = "available" | "unavailable";

export interface LocalOnnxTransformersProbeResult {
  readonly availability: LocalOnnxTransformersAvailability;
  readonly code?: string;
}

export type LocalOnnxTransformersProbe = () => LocalOnnxTransformersProbeResult;

export type LocalOnnxTransformersSpecifierResolver = (specifier: string) => unknown;

export function isLocalOnnxTransformersModuleNotFound(error: unknown): boolean {
  return localOnnxTransformersMissingCode(error) === "ERR_MODULE_NOT_FOUND";
}

export function localOnnxTransformersMissingCode(error: unknown): string | null {
  const code = (error as { code?: string }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return "ERR_MODULE_NOT_FOUND";
  }
  return null;
}

export function probeLocalOnnxTransformersPackage(
  resolveSpecifier: LocalOnnxTransformersSpecifierResolver = resolveLocalOnnxTransformersSpecifier
): LocalOnnxTransformersProbeResult {
  try {
    resolveSpecifier(TRANSFORMERS_PACKAGE);
    return { availability: "available" };
  } catch (error) {
    return {
      availability: "unavailable",
      code: localOnnxTransformersMissingCode(error) ?? "ERR_MODULE_NOT_FOUND"
    };
  }
}

export async function importLocalOnnxTransformers(): Promise<LocalOnnxEmbeddingTransformersModule> {
  try {
    return (await import(TRANSFORMERS_PACKAGE)) as LocalOnnxEmbeddingTransformersModule;
  } catch (error) {
    // Packaging miss, not an unreadable model artifact.
    if (isLocalOnnxTransformersModuleNotFound(error)) {
      throw new Error(
        "@huggingface/transformers is required for the local ONNX embedding provider. Install the optional extra: pnpm add @huggingface/transformers --filter @do-soul/alaya-core",
        { cause: error }
      );
    }
    throw error;
  }
}

function resolveLocalOnnxTransformersSpecifier(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}
