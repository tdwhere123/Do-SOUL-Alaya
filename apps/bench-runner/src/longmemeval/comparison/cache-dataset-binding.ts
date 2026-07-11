import type { LongMemEvalRunProvenance } from "../provenance/run.js";
import {
  parseLongMemEvalVariant,
  requireNonEmptyString
} from "./dataset-identity.js";

export function validateCacheDatasetBinding(
  cache: NonNullable<LongMemEvalRunProvenance["extraction_cache"]>,
  manifest: LongMemEvalRunProvenance["question_manifest"],
  identity: Readonly<Record<string, unknown>>,
  actualDatasetSha256?: string
): void {
  const datasetName = requireNonEmptyString(identity.dataset_name, "KPI dataset name");
  const datasetChecksum = requireNonEmptyString(
    identity.dataset_checksum_sha256,
    "KPI dataset checksum"
  );
  const variant = parseLongMemEvalVariant(datasetName);
  if (cache.dataset !== variant.replaceAll("_", "-")) {
    throw new Error("extraction cache logical dataset does not match KPI variant");
  }
  if (/^[a-f0-9]{64}$/u.test(cache.dataset_revision)) {
    validatePinnedRevision(cache.dataset_revision, datasetChecksum, actualDatasetSha256);
    return;
  }
  if (cache.dataset_revision !== "unpinned") {
    throw new Error("unsupported extraction cache dataset revision");
  }
  validateUnpinnedRevision(manifest, variant, datasetChecksum, actualDatasetSha256);
}

function validatePinnedRevision(
  revision: string,
  datasetChecksum: string,
  actualDatasetSha256: string | undefined
): void {
  if (revision !== datasetChecksum) {
    throw new Error("extraction cache dataset revision does not match KPI dataset");
  }
  if (actualDatasetSha256 !== undefined && revision !== actualDatasetSha256) {
    throw new Error("extraction cache/actual dataset SHA-256 mismatch");
  }
}

function validateUnpinnedRevision(
  manifest: LongMemEvalRunProvenance["question_manifest"],
  variant: string,
  datasetChecksum: string,
  actualDatasetSha256: string | undefined
): void {
  if (actualDatasetSha256 === undefined || !/^[a-f0-9]{64}$/u.test(actualDatasetSha256)) {
    throw new Error("unpinned extraction cache requires actual dataset SHA-256");
  }
  if (datasetChecksum !== "unpinned" && datasetChecksum !== actualDatasetSha256) {
    throw new Error("KPI dataset checksum does not match actual dataset SHA-256");
  }
  if (manifest === null) {
    throw new Error("unpinned extraction cache requires question manifest provenance");
  }
  if (manifest.variant !== variant || manifest.dataset_sha256 !== actualDatasetSha256) {
    throw new Error("unpinned extraction cache question manifest/actual dataset SHA-256 mismatch");
  }
}
