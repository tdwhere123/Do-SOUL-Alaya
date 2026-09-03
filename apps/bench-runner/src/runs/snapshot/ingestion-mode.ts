import { createHash } from "node:crypto";
import { hasCompleteExtractionFillAuthority } from
  "../extraction/fill/fill-authority.js";
import type { ExtractionCacheManifest } from
  "../extraction/cache/extraction-cache-manifest.js";

export const COMPACT_RUN_PROVENANCE_SCHEMA_VERSION = 2;
export type IngestionMode = "precomputed_full" | "lazy_field";

export function resolveIngestionMode(input: {
  readonly schemaVersion: 1 | 2;
  readonly ingestionMode?: IngestionMode;
  readonly completeV3Authority?: boolean;
}): IngestionMode {
  const schemaVersion = input.schemaVersion;
  const ingestionMode = input.ingestionMode;
  const completeV3Authority = input.completeV3Authority;
  if (schemaVersion === 2) {
    if (ingestionMode === undefined) {
      throw new Error("compact run provenance v2 requires ingestion_mode");
    }
    return ingestionMode;
  }
  if (ingestionMode !== undefined) {
    throw new Error("legacy provenance cannot carry ingestion_mode");
  }
  if (completeV3Authority !== true) {
    throw new Error(
      "legacy provenance cannot imply ingestion_mode without complete-v3 authority"
    );
  }
  return "precomputed_full";
}

export function completeV3AuthorityFromManifest(
  manifest: ExtractionCacheManifest | undefined
): boolean {
  return manifest !== undefined && hasCompleteExtractionFillAuthority(manifest);
}

export function compactRunIdentity(input: {
  readonly substrateIdentity: string;
  readonly ingestionMode: IngestionMode;
  readonly overlayIdentity: string;
  readonly lazyRunIdentity?: string;
}): string {
  const substrateIdentity = input.substrateIdentity;
  const ingestionMode = input.ingestionMode;
  const overlayIdentity = input.overlayIdentity;
  const lazyRunIdentity = input.lazyRunIdentity;
  if (!/^[a-f0-9]{64}$/u.test(substrateIdentity) ||
      !/^[a-f0-9]{64}$/u.test(overlayIdentity) ||
      (ingestionMode === "lazy_field" &&
        !/^[a-f0-9]{64}$/u.test(lazyRunIdentity ?? ""))) {
    throw new Error("run identity digests must be sha256 hex");
  }
  return createHash("sha256")
    .update(String(COMPACT_RUN_PROVENANCE_SCHEMA_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(substrateIdentity, "utf8")
    .update("\u0000", "utf8")
    .update(ingestionMode, "utf8")
    .update("\u0000", "utf8")
    .update(overlayIdentity, "utf8")
    .update("\u0000", "utf8")
    .update(lazyRunIdentity ?? "precomputed", "utf8")
    .digest("hex");
}
