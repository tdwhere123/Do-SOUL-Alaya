import { isCacheOnlySeedExtractionPath, type SeedExtractionPath } from
  "@do-soul/alaya-eval";
import { EXTRACTION_CACHE_MANIFEST_VERSION } from
  "../../extraction/cache/extraction-cache-manifest.js";
import {
  containsExtractionFillQuestionWindow,
  hasCompleteExtractionFillSummary
} from "../../extraction/fill/fill-authority.js";
import type { LongMemEvalRunProvenance } from "../../provenance/run.js";
import type { SnapshotExtractionProvenanceV3 } from "../materialize.js";

export type SnapshotWriteAuthority = "diagnostic" | "promotion";

export interface DiagnosticSnapshotWriteInput {
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
  readonly datasetSha256: string;
}

export function assertDiagnosticSnapshotWriteAuthority(
  input: DiagnosticSnapshotWriteInput
): void {
  assertDiagnosticCacheOnlyPath(input.seedExtractionPath);
  const cache = requireCompleteV3Fill(input);
  assertDiagnosticFillWindow(cache, input.runProvenance);
  assertDiagnosticIdentity(input, cache);
}

function assertDiagnosticCacheOnlyPath(path: SeedExtractionPath): void {
  if (!isCacheOnlySeedExtractionPath(path)) {
    throw new Error("diagnostic snapshot writer requires a cache-only seed extraction path");
  }
}

function requireCompleteV3Fill(
  input: DiagnosticSnapshotWriteInput
): NonNullable<LongMemEvalRunProvenance["extraction_cache"]> & {
  readonly schema_version: typeof EXTRACTION_CACHE_MANIFEST_VERSION;
} {
  const cache = input.runProvenance.extraction_cache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      !hasCompleteExtractionFillSummary(cache) ||
      !hasCompleteExtractionFillSummary(input.extraction)) {
    throw new Error("diagnostic snapshot writer requires a complete v3 fill summary");
  }
  return cache;
}

function assertDiagnosticFillWindow(
  cache: Parameters<typeof containsExtractionFillQuestionWindow>[0],
  provenance: LongMemEvalRunProvenance
): void {
  if (!containsExtractionFillQuestionWindow(
    cache,
    provenance.execution.offset,
    provenance.execution.evaluated_count
  )) {
    throw new Error(
      "diagnostic snapshot writer execution window is not contained in the cache fill window"
    );
  }
}

function assertDiagnosticIdentity(
  input: DiagnosticSnapshotWriteInput,
  cache: NonNullable<LongMemEvalRunProvenance["extraction_cache"]>
): void {
  const datasetSha = input.datasetSha256;
  const provenanceDataset = input.runProvenance.dataset_sha256 ??
    input.runProvenance.question_manifest?.dataset_sha256;
  const selection = input.runProvenance.selection;
  if (provenanceDataset !== datasetSha ||
      cache.dataset_revision !== datasetSha ||
      input.extraction.dataset_revision !== datasetSha ||
      (selection !== undefined && selection.dataset_sha256 !== datasetSha)) {
    throw new Error("diagnostic snapshot writer dataset identity mismatch");
  }
  if (input.extraction.extraction_model !== cache.extraction_model) {
    throw new Error("diagnostic snapshot writer extraction model identity mismatch");
  }
  if (input.extraction.request_profile !== cache.request_profile) {
    throw new Error("diagnostic snapshot writer request profile identity mismatch");
  }
}
