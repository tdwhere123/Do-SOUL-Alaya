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
export type SnapshotConsumeAuthority = SnapshotWriteAuthority;
export type DiagnosticSnapshotAuthorityRole = "writer" | "consumer";

export interface DiagnosticSnapshotProvenance {
  readonly extraction_cache: LongMemEvalRunProvenance["extraction_cache"];
  readonly dataset_sha256?: string;
  readonly question_manifest?: LongMemEvalRunProvenance["question_manifest"];
  readonly selection?: LongMemEvalRunProvenance["selection"];
  readonly execution: LongMemEvalRunProvenance["execution"];
}

export interface DiagnosticSnapshotWriteInput {
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: DiagnosticSnapshotProvenance;
  readonly datasetSha256: string;
}

export function assertDiagnosticSnapshotWriteAuthority(
  input: DiagnosticSnapshotWriteInput,
  role: DiagnosticSnapshotAuthorityRole = "writer"
): void {
  assertDiagnosticCacheOnlyPath(input.seedExtractionPath, role);
  const cache = requireCompleteV3Fill(input, role);
  assertDiagnosticFillWindow(cache, input.runProvenance, role);
  assertDiagnosticIdentity(input, cache, role);
}

function diagnosticRoleLabel(role: DiagnosticSnapshotAuthorityRole): string {
  return role === "consumer"
    ? "diagnostic snapshot consumer"
    : "diagnostic snapshot writer";
}

function assertDiagnosticCacheOnlyPath(
  path: SeedExtractionPath,
  role: DiagnosticSnapshotAuthorityRole
): void {
  if (!isCacheOnlySeedExtractionPath(path)) {
    throw new Error(
      `${diagnosticRoleLabel(role)} requires a cache-only seed extraction path`
    );
  }
}

function requireCompleteV3Fill(
  input: DiagnosticSnapshotWriteInput,
  role: DiagnosticSnapshotAuthorityRole
): NonNullable<DiagnosticSnapshotProvenance["extraction_cache"]> & {
  readonly schema_version: typeof EXTRACTION_CACHE_MANIFEST_VERSION;
} {
  const cache = input.runProvenance.extraction_cache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      !hasCompleteExtractionFillSummary(cache) ||
      !hasCompleteExtractionFillSummary(input.extraction)) {
    throw new Error(
      `${diagnosticRoleLabel(role)} requires a complete v3 fill summary`
    );
  }
  return cache;
}

function assertDiagnosticFillWindow(
  cache: Parameters<typeof containsExtractionFillQuestionWindow>[0],
  provenance: DiagnosticSnapshotProvenance,
  role: DiagnosticSnapshotAuthorityRole
): void {
  if (!containsExtractionFillQuestionWindow(
    cache,
    provenance.execution.offset,
    provenance.execution.evaluated_count
  )) {
    throw new Error(
      `${diagnosticRoleLabel(role)} execution window is not contained in the cache fill window`
    );
  }
}

function assertDiagnosticIdentity(
  input: DiagnosticSnapshotWriteInput,
  cache: NonNullable<DiagnosticSnapshotProvenance["extraction_cache"]>,
  role: DiagnosticSnapshotAuthorityRole
): void {
  const datasetSha = input.datasetSha256;
  const provenanceDataset = input.runProvenance.dataset_sha256 ??
    input.runProvenance.question_manifest?.dataset_sha256;
  const selection = input.runProvenance.selection;
  if (provenanceDataset !== datasetSha ||
      cache.dataset_revision !== datasetSha ||
      input.extraction.dataset_revision !== datasetSha ||
      (selection !== undefined && selection.dataset_sha256 !== datasetSha)) {
    throw new Error(`${diagnosticRoleLabel(role)} dataset identity mismatch`);
  }
  if (input.extraction.extraction_model !== cache.extraction_model) {
    throw new Error(
      `${diagnosticRoleLabel(role)} extraction model identity mismatch`
    );
  }
  if (input.extraction.request_profile !== cache.request_profile) {
    throw new Error(
      `${diagnosticRoleLabel(role)} request profile identity mismatch`
    );
  }
}
