import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  snapshotExtractionAuthorityPath,
  snapshotManifestPath,
  snapshotSidecarPath,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotSidecarFile
} from "../materialize.js";
import { validateSnapshotManifest } from "../manifest-validation.js";
import { parseSnapshotSidecar } from "../sidecar-validation.js";
import {
  copyRegularFileNoFollow,
  readRegularFileNoFollow,
  sha256Buffer
} from "../bound-file.js";
import { assertCurrentSnapshotAttributionClaim } from "./current-attribution.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  parseSnapshotExtractionAuthorityBytes,
  type SnapshotExtractionAuthority
} from "../extraction-authority.js";
import { bindSnapshotRunProvenanceAuthority } from "../run-provenance.js";
import { isLongMemEvalRunProvenanceGateEligible } from "../../provenance/run.js";
import {
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_SIDECAR_BYTES
} from "../artifact-limits.js";

export interface BoundCurrentSnapshotArtifacts {
  readonly snapshotDbPath: string;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly manifestSha256: string;
}

export function bindCurrentSnapshotArtifacts(input: {
  readonly sourceDbPath: string;
  readonly targetRoot: string;
}): BoundCurrentSnapshotArtifacts {
  const current = readCurrentManifest(input.sourceDbPath);
  const authority = readCurrentExtractionAuthority(
    input.sourceDbPath,
    current.manifest,
    current.integrity
  );
  const sidecar = readCurrentSidecar(input.sourceDbPath, current.integrity);
  const snapshotDbPath = join(input.targetRoot, basename(input.sourceDbPath));
  copyRegularFileNoFollow({
    sourcePath: input.sourceDbPath,
    targetPath: snapshotDbPath,
    expectedSha256: current.integrity.db_sha256
  });
  writeBoundMetadata(
    snapshotDbPath,
    current.bytes,
    sidecar.bytes,
    authority.bytes
  );
  return {
    snapshotDbPath,
    manifest: current.manifest,
    sidecar: sidecar.value,
    extractionAuthority: authority.value,
    manifestSha256: sha256Buffer(current.bytes)
  };
}

function readCurrentManifest(sourceDbPath: string) {
  const manifestBytes = readRegularFileNoFollow(
    snapshotManifestPath(sourceDbPath),
    MAX_SNAPSHOT_MANIFEST_BYTES
  );
  const manifest = validateSnapshotManifest(
    parseJson(manifestBytes, "current snapshot manifest"),
    snapshotManifestPath(sourceDbPath)
  );
  assertCurrentSnapshotAttributionClaim(manifest);
  return { bytes: manifestBytes, manifest, integrity: requireIntegrity(manifest) };
}

function readCurrentExtractionAuthority(
  sourceDbPath: string,
  manifest: LongMemEvalSnapshotManifest,
  integrity: NonNullable<LongMemEvalSnapshotManifest["artifact_integrity"]>
) {
  const authorityPath = snapshotExtractionAuthorityPath(sourceDbPath);
  const authorityBytes = readRegularFileNoFollow(
    authorityPath,
    MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
  );
  assertAuthorityIntegrity(authorityPath, authorityBytes, integrity);
  const extractionAuthority = parseSnapshotExtractionAuthorityBytes(
    authorityBytes,
    authorityPath
  );
  if (manifest.extraction_provenance?.schema_version !== 3) {
    throw new Error("current snapshot extraction provenance is incomplete");
  }
  assertSnapshotExtractionAuthorityBinding(
    extractionAuthority,
    manifest.extraction_provenance
  );
  assertCurrentRunAuthority(manifest, extractionAuthority);
  return { bytes: authorityBytes, value: extractionAuthority };
}

function assertCurrentRunAuthority(
  manifest: LongMemEvalSnapshotManifest,
  extractionAuthority: SnapshotExtractionAuthority
): void {
  if (manifest.run_provenance === undefined ||
      !isLongMemEvalRunProvenanceGateEligible(
        bindSnapshotRunProvenanceAuthority(
          manifest.run_provenance,
          extractionAuthority
        )
      )) {
    throw new Error("current snapshot run authority is incomplete");
  }
}

function readCurrentSidecar(
  sourceDbPath: string,
  integrity: NonNullable<LongMemEvalSnapshotManifest["artifact_integrity"]>
) {
  const sidecarBytes = readRegularFileNoFollow(
    snapshotSidecarPath(sourceDbPath),
    MAX_SNAPSHOT_SIDECAR_BYTES
  );
  if (sha256Buffer(sidecarBytes) !== integrity.sidecar_sha256) {
    throw new Error("recall-eval snapshot sidecar SHA-256 mismatch");
  }
  const sidecar = parseSnapshotSidecar(
    parseJson(sidecarBytes, "current snapshot sidecar"),
    snapshotSidecarPath(sourceDbPath),
    RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION
  );
  return { bytes: sidecarBytes, value: sidecar };
}

function writeBoundMetadata(
  snapshotDbPath: string,
  manifestBytes: Buffer,
  sidecarBytes: Buffer,
  authorityBytes: Buffer
): void {
  writeFileSync(snapshotManifestPath(snapshotDbPath), manifestBytes, { flag: "wx", mode: 0o400 });
  writeFileSync(snapshotSidecarPath(snapshotDbPath), sidecarBytes, { flag: "wx", mode: 0o400 });
  writeFileSync(snapshotExtractionAuthorityPath(snapshotDbPath), authorityBytes, {
    flag: "wx",
    mode: 0o400
  });
}

function requireIntegrity(manifest: LongMemEvalSnapshotManifest) {
  const integrity = manifest.artifact_integrity;
  if (integrity?.extraction_authority_filename === undefined ||
      integrity.extraction_authority_sha256 === undefined ||
      integrity.extraction_authority_bytes === undefined) {
    throw new Error("current snapshot requires artifact integrity");
  }
  return integrity;
}

function assertAuthorityIntegrity(
  filePath: string,
  bytes: Buffer,
  integrity: NonNullable<LongMemEvalSnapshotManifest["artifact_integrity"]>
): void {
  if (basename(filePath) !== integrity.extraction_authority_filename ||
      bytes.byteLength !== integrity.extraction_authority_bytes ||
      sha256Buffer(bytes) !== integrity.extraction_authority_sha256) {
    throw new Error("recall-eval snapshot extraction authority mismatch");
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not strict UTF-8 JSON: ${detail}`);
  }
}
