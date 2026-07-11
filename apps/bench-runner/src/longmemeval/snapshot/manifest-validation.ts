import { LongMemEvalRunProvenanceSchema } from "../provenance/run.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  type LongMemEvalSnapshotManifest
} from "../snapshot.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import type { SnapshotArtifactIntegrity } from "./integrity.js";

export function validateSnapshotManifest(
  parsed: unknown,
  filePath: string
): LongMemEvalSnapshotManifest {
  const record = requireManifestRecord(parsed, filePath);
  validateManifestBase(record, filePath);
  validateOptionalShaFields(record, filePath);
  const runProvenance = record.run_provenance === undefined
    ? undefined
    : LongMemEvalRunProvenanceSchema.parse(record.run_provenance);
  const artifactIntegrity = parseArtifactIntegrity(record.artifact_integrity, filePath);
  const storedAttribution = parseSnapshotAttribution(record.attribution, filePath);
  const manifest = parsed as LongMemEvalSnapshotManifest;
  const derivedAttribution = deriveSnapshotAttribution({
    artifactIntegrity,
    runProvenance,
    questionIdDigest: optionalString(record.question_id_digest),
    datasetSha256: optionalString(record.dataset_sha256),
    extractionProvenance: manifest.extraction_provenance
  });
  assertAttributionClaim(storedAttribution, derivedAttribution, filePath);
  return {
    ...manifest,
    ...(artifactIntegrity === undefined ? {} : { artifact_integrity: artifactIntegrity }),
    ...(runProvenance === undefined ? {} : { run_provenance: runProvenance }),
    attribution: storedAttribution?.status === "attributed"
      ? derivedAttribution
      : { status: "legacy_unattributed", gate_eligible: false }
  };
}

function requireManifestRecord(parsed: unknown, filePath: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function validateManifestBase(record: Record<string, unknown>, filePath: string): void {
  if (typeof record.recall_pipeline_version !== "string" || record.recall_pipeline_version.length === 0) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} missing recall_pipeline_version`);
  }
  if (typeof record.schema_migration_version !== "number" || Number.isNaN(record.schema_migration_version)) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} missing schema_migration_version`);
  }
  if (record.schema_version !== RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has unsupported schema_version`);
  }
}

function validateOptionalShaFields(record: Record<string, unknown>, filePath: string): void {
  for (const field of ["question_id_digest", "dataset_sha256"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) {
      throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid ${field}`);
    }
  }
}

function parseArtifactIntegrity(
  value: unknown,
  filePath: string
): SnapshotArtifactIntegrity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid artifact_integrity`);
  }
  const record = value as Record<string, unknown>;
  for (const field of ["db_sha256", "sidecar_sha256"] as const) {
    if (typeof record[field] !== "string" || !/^[a-f0-9]{64}$/u.test(record[field])) {
      throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid ${field}`);
    }
  }
  return record as unknown as SnapshotArtifactIntegrity;
}

function parseSnapshotAttribution(
  value: unknown,
  filePath: string
): LongMemEvalSnapshotManifest["attribution"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid attribution`);
  }
  const record = value as Record<string, unknown>;
  if ((record.status !== "attributed" && record.status !== "legacy_unattributed") ||
      typeof record.gate_eligible !== "boolean") {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid attribution`);
  }
  return record as NonNullable<LongMemEvalSnapshotManifest["attribution"]>;
}

function assertAttributionClaim(
  stored: LongMemEvalSnapshotManifest["attribution"],
  derived: NonNullable<LongMemEvalSnapshotManifest["attribution"]>,
  filePath: string
): void {
  if (stored?.status === "attributed" && derived.status !== "attributed") {
    throw new Error(`recall-eval attributed snapshot manifest at ${filePath} is incomplete`);
  }
  if (stored?.gate_eligible === true && !derived.gate_eligible) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} overclaims gate eligibility`);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
