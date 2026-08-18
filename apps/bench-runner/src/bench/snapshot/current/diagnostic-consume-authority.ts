import type {
  LongMemEvalSnapshotManifest,
  SnapshotExtractionProvenanceV3
} from "../materialize.js";
import {
  assertDiagnosticSnapshotWriteAuthority,
  type DiagnosticSnapshotProvenance
} from "./diagnostic-write-authority.js";

export function assertDiagnosticManifestConsumeAuthority(
  manifest: LongMemEvalSnapshotManifest
): SnapshotExtractionProvenanceV3 {
  const extraction = manifest.extraction_provenance;
  if (manifest.artifact_integrity === undefined) {
    throw new Error("diagnostic snapshot consumer requires artifact integrity");
  }
  if (manifest.dataset_sha256 === undefined ||
      manifest.question_id_digest === undefined) {
    throw new Error(
      "diagnostic snapshot consumer requires dataset and question identity"
    );
  }
  if (extraction?.schema_version !== 3) {
    throw new Error(
      "diagnostic snapshot consumer requires v3 extraction provenance"
    );
  }
  if (manifest.run_provenance === undefined) {
    throw new Error("diagnostic snapshot consumer requires run provenance");
  }
  const selection = manifest.run_provenance.selection;
  if (selection === undefined ||
      selection.dataset_sha256 !== manifest.dataset_sha256 ||
      selection.selected_count !== manifest.question_count ||
      selection.selected_id_digest !== manifest.question_id_digest) {
    throw new Error(
      "diagnostic snapshot consumer selection identity mismatch"
    );
  }
  return extraction;
}

export function assertDiagnosticSnapshotConsumeAuthority(input: {
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly seedExtractionPath: LongMemEvalSnapshotManifest["seed_extraction_path"];
  readonly runProvenance: DiagnosticSnapshotProvenance;
  readonly datasetSha256: string;
}): void {
  if (input.seedExtractionPath === undefined) {
    throw new Error(
      "diagnostic snapshot consumer requires a cache-only seed extraction path"
    );
  }
  assertDiagnosticSnapshotWriteAuthority({
    extraction: input.extraction,
    seedExtractionPath: input.seedExtractionPath,
    runProvenance: input.runProvenance,
    datasetSha256: input.datasetSha256
  }, "consumer");
}
