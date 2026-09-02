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
  if (input.schemaVersion === 2) {
    if (input.ingestionMode === undefined) {
      throw new Error("compact run provenance v2 requires ingestion_mode");
    }
    return input.ingestionMode;
  }
  if (input.ingestionMode !== undefined) {
    throw new Error("legacy provenance cannot carry ingestion_mode");
  }
  if (input.completeV3Authority !== true) {
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
}): string {
  if (!/^[a-f0-9]{64}$/u.test(input.substrateIdentity) ||
      !/^[a-f0-9]{64}$/u.test(input.overlayIdentity)) {
    throw new Error("run identity digests must be sha256 hex");
  }
  return createHash("sha256")
    .update(String(COMPACT_RUN_PROVENANCE_SCHEMA_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(input.substrateIdentity, "utf8")
    .update("\u0000", "utf8")
    .update(input.ingestionMode, "utf8")
    .update("\u0000", "utf8")
    .update(input.overlayIdentity, "utf8")
    .digest("hex");
}
