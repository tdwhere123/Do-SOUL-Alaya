import { LongMemEvalRunProvenanceSchema } from "../provenance/run.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES
} from "../extraction-cache-manifest.js";
import { z } from "zod";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  type LongMemEvalSnapshotManifest
} from "../snapshot.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import type { SnapshotArtifactIntegrity } from "./integrity.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SnapshotExtractionBaseSchema = z.object({
  manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: z.string().min(1),
  coverage: z.number().min(0).max(1).optional(),
  cached_turns: z.number().int().nonnegative().optional(),
  requested_turns: z.number().int().nonnegative().optional()
}).strict();
const SnapshotExtractionProvenanceSchema = z.discriminatedUnion("schema_version", [
  SnapshotExtractionBaseSchema.extend({
    schema_version: z.literal(1),
    model_family: z.never().optional(),
    request_profile: z.never().optional()
  }).strict(),
  SnapshotExtractionBaseSchema.extend({
    schema_version: z.literal(2),
    model_family: z.string().min(1),
    request_profile: z.never().optional()
  }).strict(),
  SnapshotExtractionBaseSchema.extend({
    schema_version: z.literal(EXTRACTION_CACHE_MANIFEST_VERSION),
    model_family: z.string().min(1),
    request_profile: z.enum(EXTRACTION_REQUEST_PROFILES)
  }).strict()
]);

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
  const extractionProvenance = parseExtractionProvenance(
    record.extraction_provenance,
    filePath
  );
  const manifest = {
    ...(parsed as LongMemEvalSnapshotManifest),
    extraction_provenance: extractionProvenance
  };
  const derivedAttribution = deriveSnapshotAttribution({
    artifactIntegrity,
    runProvenance,
    questionIdDigest: optionalString(record.question_id_digest),
    datasetSha256: optionalString(record.dataset_sha256),
    extractionProvenance
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

function parseExtractionProvenance(
  value: unknown,
  filePath: string
): LongMemEvalSnapshotManifest["extraction_provenance"] {
  if (value === null || value === undefined) return null;
  const parsed = SnapshotExtractionProvenanceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .filter((field) => field.length > 0)
    .join(", ");
  throw new Error(
    `recall-eval snapshot manifest at ${filePath} has invalid extraction provenance: ${fields}`
  );
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
