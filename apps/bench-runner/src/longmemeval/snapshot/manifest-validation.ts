import { z } from "zod";
import {
  SeedExtractionPathSchema,
  type SeedExtractionPath
} from "@do-soul/alaya-eval";
import { LongMemEvalSnapshotRunProvenanceSchema } from "./run-provenance.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES
} from "../extraction/cache/extraction-cache-manifest.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  type LongMemEvalSnapshotManifest
} from "./materialize.js";
import { deriveSnapshotAttribution } from "./attribution.js";
import type { SnapshotArtifactIntegrity } from "./integrity.js";
import {
  EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS
} from "../extraction/fill/fill-authority.js";
import { LongMemEvalExpansionLineageSchema } from
  "../promotion/expansion/lineage/expansion-lineage-schema.js";
import { LongMemEvalExpansionSourceAnchorSchema } from
  "../promotion/expansion/lineage/expansion-source-anchor-schema.js";

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
    request_profile: z.enum(EXTRACTION_REQUEST_PROFILES),
    expansion_source_anchor: LongMemEvalExpansionSourceAnchorSchema.optional(),
    expansion_lineage: LongMemEvalExpansionLineageSchema.optional(),
    ...EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS
  }).strict()
]);
const SnapshotManifestRecordSchema = z.record(z.string(), z.unknown());
const SnapshotArtifactIntegritySchema = z
  .object({
    db_sha256: Sha256Schema,
    sidecar_sha256: Sha256Schema,
    extraction_authority_filename: z.string().min(1).optional(),
    extraction_authority_sha256: Sha256Schema.optional(),
    extraction_authority_bytes: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const fields = [
      value.extraction_authority_filename,
      value.extraction_authority_sha256,
      value.extraction_authority_bytes
    ];
    if (fields.every((field) => field === undefined) ||
        fields.every((field) => field !== undefined)) return;
    context.addIssue({
      code: "custom",
      message: "extraction authority integrity fields must be complete"
    });
  })
  .readonly();
const SnapshotAttributionSchema = z
  .object({
    status: z.enum(["attributed", "legacy_unattributed"]),
    gate_eligible: z.boolean()
  })
  .readonly();

export function validateSnapshotManifest(
  parsed: unknown,
  filePath: string,
  options: { readonly allowLegacyV1?: boolean } = {}
): LongMemEvalSnapshotManifest {
  const record = requireManifestRecord(parsed, filePath);
  const legacyV1 = validateManifestBase(record, filePath, options.allowLegacyV1 === true);
  validateOptionalShaFields(record, filePath);
  const runProvenance = record.run_provenance === undefined
    ? undefined
    : LongMemEvalSnapshotRunProvenanceSchema.parse(record.run_provenance);
  const artifactIntegrity = parseArtifactIntegrity(record.artifact_integrity, filePath);
  const storedAttribution = parseSnapshotAttribution(record.attribution, filePath);
  const seedExtractionPath = parseSeedExtractionPath(
    record.seed_extraction_path,
    filePath
  );
  const extractionProvenance = legacyV1
    ? null
    : parseExtractionProvenance(record.extraction_provenance, filePath);
  const manifest = {
    ...(parsed as LongMemEvalSnapshotManifest),
    extraction_provenance: extractionProvenance,
    ...(seedExtractionPath === undefined
      ? {}
      : { seed_extraction_path: seedExtractionPath })
  };
  const derivedAttribution = deriveSnapshotAttribution({
    artifactIntegrity,
    runProvenance,
    questionIdDigest: optionalString(record.question_id_digest),
    datasetSha256: optionalString(record.dataset_sha256),
    seedExtractionPath,
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

function parseSeedExtractionPath(
  value: unknown,
  filePath: string
): SeedExtractionPath | undefined {
  if (value === undefined) return undefined;
  const parsed = SeedExtractionPathSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `recall-eval snapshot manifest at ${filePath} has invalid seed_extraction_path`
  );
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
  const result = SnapshotManifestRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} is not an object`);
  }
  return result.data;
}

function validateManifestBase(
  record: Record<string, unknown>,
  filePath: string,
  allowLegacyV1: boolean
): boolean {
  if (typeof record.recall_pipeline_version !== "string" || record.recall_pipeline_version.length === 0) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} missing recall_pipeline_version`);
  }
  if (!Number.isSafeInteger(record.schema_migration_version) ||
      (record.schema_migration_version as number) < 0) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} missing schema_migration_version`);
  }
  const legacyV1 = allowLegacyV1 && record.schema_version === 1;
  if (!legacyV1 && record.schema_version !== RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has unsupported schema_version`);
  }
  return legacyV1;
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
  try {
    return SnapshotArtifactIntegritySchema.parse(value);
  } catch {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid artifact_integrity`);
  }
}

function parseSnapshotAttribution(
  value: unknown,
  filePath: string
): LongMemEvalSnapshotManifest["attribution"] {
  if (value === undefined) return undefined;
  try {
    return SnapshotAttributionSchema.parse(value);
  } catch {
    throw new Error(`recall-eval snapshot manifest at ${filePath} has invalid attribution`);
  }
}

function assertAttributionClaim(
  stored: LongMemEvalSnapshotManifest["attribution"],
  derived: NonNullable<LongMemEvalSnapshotManifest["attribution"]>,
  filePath: string
): void {
  if (stored === undefined) return;
  if (stored?.status === "attributed" && derived.status !== "attributed") {
    throw new Error(`recall-eval attributed snapshot manifest at ${filePath} is incomplete`);
  }
  if (stored?.gate_eligible === true && !derived.gate_eligible) {
    throw new Error(`recall-eval snapshot manifest at ${filePath} overclaims gate eligibility`);
  }
  if (stored.status !== derived.status ||
      stored.gate_eligible !== derived.gate_eligible) {
    throw new Error(
      `recall-eval snapshot manifest at ${filePath} attribution claim differs from derived evidence`
    );
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
