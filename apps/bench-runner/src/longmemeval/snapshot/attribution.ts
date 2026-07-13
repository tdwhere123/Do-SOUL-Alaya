import {
  isLongMemEvalRunProvenanceGateEligible,
  type LongMemEvalRunProvenance
} from "../provenance/run.js";
import { EXTRACTION_CACHE_MANIFEST_VERSION } from "../extraction-cache-manifest.js";
import type {
  LongMemEvalSnapshotManifest,
  SnapshotExtractionProvenance
} from "../snapshot.js";
import type { SnapshotArtifactIntegrity } from "./integrity.js";

export function deriveSnapshotAttribution(input: {
  readonly artifactIntegrity?: SnapshotArtifactIntegrity;
  readonly runProvenance?: LongMemEvalRunProvenance;
  readonly questionIdDigest?: string;
  readonly datasetSha256?: string;
  readonly extractionProvenance?: SnapshotExtractionProvenance | null;
}): NonNullable<LongMemEvalSnapshotManifest["attribution"]> {
  if (!hasCompleteBinding(input)) {
    return { status: "legacy_unattributed", gate_eligible: false };
  }
  const provenance = input.runProvenance!;
  return {
    status: "attributed",
    gate_eligible:
      isLongMemEvalRunProvenanceGateEligible(provenance) &&
      hasGateEligibleExtractionCache(
        provenance,
        input.datasetSha256,
        input.extractionProvenance
      )
  };
}

function hasCompleteBinding(input: Parameters<typeof deriveSnapshotAttribution>[0]): boolean {
  return (
    input.artifactIntegrity !== undefined &&
    input.runProvenance !== undefined &&
    input.questionIdDigest !== undefined &&
    input.datasetSha256 !== undefined
  );
}

function hasGateEligibleExtractionCache(
  provenance: LongMemEvalRunProvenance,
  datasetSha256: string | undefined,
  snapshotCache: SnapshotExtractionProvenance | null | undefined
): boolean {
  const cache = provenance.extraction_cache;
  const provenanceDatasetSha = resolveProvenanceDatasetSha(provenance);
  return (
    cache !== null && snapshotCache != null &&
    cache.schema_version === EXTRACTION_CACHE_MANIFEST_VERSION &&
    snapshotCache.schema_version === EXTRACTION_CACHE_MANIFEST_VERSION &&
    provenanceDatasetSha !== undefined &&
    datasetSha256 === provenanceDatasetSha &&
    snapshotCache.manifest_sha256 === cache.manifest_sha256 &&
    snapshotCache.extraction_model === cache.extraction_model &&
    snapshotCache.model_family === cache.model_family &&
    snapshotCache.request_profile === cache.request_profile &&
    snapshotCache.provider_url === cache.provider_url &&
    snapshotCache.system_prompt_sha256 === cache.system_prompt_sha256 &&
    snapshotCache.cache_key_algo === cache.cache_key_algo &&
    snapshotCache.dataset === cache.dataset &&
    snapshotCache.dataset_revision === cache.dataset_revision &&
    cache.requested_turns !== undefined && cache.cached_turns !== undefined &&
    cache.coverage === 1 && cache.cached_turns >= cache.requested_turns &&
    snapshotCache.requested_turns === cache.requested_turns &&
    snapshotCache.cached_turns === cache.cached_turns &&
    snapshotCache.coverage === cache.coverage
  );
}

function resolveProvenanceDatasetSha(
  provenance: LongMemEvalRunProvenance
): string | undefined {
  const manifestSha = provenance.question_manifest?.dataset_sha256;
  if (manifestSha !== undefined) return manifestSha;
  const revision = provenance.extraction_cache?.dataset_revision;
  return revision !== undefined && /^[a-f0-9]{64}$/u.test(revision)
    ? revision
    : undefined;
}
