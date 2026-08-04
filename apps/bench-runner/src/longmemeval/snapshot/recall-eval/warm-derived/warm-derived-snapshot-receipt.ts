import { isAbsolute, dirname, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { readRegularFileNoFollow, sha256Buffer } from "../../bound-file.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../evidence-search-projection-rebuild-report.js";

const RECEIPT_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const CountSchema = z.number().int().nonnegative();

const FactFrameRetrofitReportSchema = z.object({
  schema_version: z.literal(1),
  ledger_sha256: Sha256Schema,
  ledger_record_count: CountSchema,
  rebuilt_owner_count: CountSchema,
  rejected_record_count: z.literal(0),
  projection_count: CountSchema,
  projection_content_sha256: Sha256Schema
}).strict().readonly();

const RebuildReportSchema = z.object({
  schema_version: z.literal(1),
  promotable: z.boolean(),
  input_db_sha256: Sha256Schema,
  rebuilt_db_identity_sha256: Sha256Schema,
  source_schema_version: CountSchema,
  working_schema_version: CountSchema,
  eligible_owner_count: CountSchema,
  rebuilt_owner_count: CountSchema,
  rejected_owner_count: CountSchema,
  zero_child_owner_count: CountSchema,
  nonzero_child_owner_count: CountSchema,
  child_count: CountSchema,
  projection_kind_counts: z.array(z.object({
    projection_kind: z.string().trim().min(1).max(128),
    child_count: CountSchema
  }).strict().readonly()),
  projection_content_sha256: Sha256Schema,
  fact_frame_retrofit: FactFrameRetrofitReportSchema.optional(),
  source_extraction_system_prompt_sha256: Sha256Schema.optional()
}).strict().readonly();

const WarmDerivedSnapshotReceiptSchema = z.object({
  schema_version: z.literal(RECEIPT_SCHEMA_VERSION),
  kind: z.literal("longmemeval_warm_derived_snapshot"),
  source_snapshot_db_sha256: Sha256Schema,
  database: z.object({
    path: z.string().trim().min(1).max(4096),
    sha256: Sha256Schema,
    schema_version: CountSchema,
    derived_rebuild_identity_sha256: Sha256Schema
  }).strict().readonly(),
  derived_evidence_projection_rebuild: RebuildReportSchema
}).strict().readonly();

export interface WarmDerivedSnapshotReceipt {
  readonly receiptSha256: string;
  readonly databasePath: string;
  readonly databaseSha256: string;
  readonly databaseSchemaVersion: number;
  readonly rebuildReport: EvidenceSearchProjectionRebuildReport;
}

export interface WarmDerivedSnapshotBinding {
  readonly receipt_sha256: string;
  readonly database_sha256: string;
  readonly database_schema_version: number;
  readonly derived_rebuild_identity_sha256: string;
}

export function readWarmDerivedSnapshotReceipt(input: {
  readonly receiptPath: string;
  readonly sourceSnapshotDbSha256: string;
  readonly sourceSchemaVersion: number;
}): WarmDerivedSnapshotReceipt {
  const bytes = readRegularFileNoFollow(input.receiptPath, MAX_RECEIPT_BYTES);
  const receipt = parseReceipt(bytes);
  assertSourceBinding(receipt, input);
  const databasePath = resolveDatabasePath(input.receiptPath, receipt.database.path);
  const report = receipt.derived_evidence_projection_rebuild;
  if (report.promotable !== false) {
    throw new Error("warm derived snapshot rebuild report must be non-promotable");
  }
  if (receipt.database.derived_rebuild_identity_sha256 !==
      report.rebuilt_db_identity_sha256) {
    throw new Error("warm derived snapshot derived rebuild identity mismatch");
  }
  if (receipt.database.schema_version !== report.working_schema_version) {
    throw new Error("warm derived snapshot working schema binding mismatch");
  }
  return Object.freeze({
    receiptSha256: sha256Buffer(bytes),
    databasePath,
    databaseSha256: receipt.database.sha256,
    databaseSchemaVersion: receipt.database.schema_version,
    rebuildReport: freezeReport(report)
  });
}

export function buildWarmDerivedSnapshotBinding(
  receipt: WarmDerivedSnapshotReceipt
): WarmDerivedSnapshotBinding {
  return Object.freeze({
    receipt_sha256: receipt.receiptSha256,
    database_sha256: receipt.databaseSha256,
    database_schema_version: receipt.databaseSchemaVersion,
    derived_rebuild_identity_sha256:
      receipt.rebuildReport.rebuilt_db_identity_sha256
  });
}

function parseReceipt(bytes: Uint8Array): z.infer<typeof WarmDerivedSnapshotReceiptSchema> {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("warm derived snapshot receipt must be valid UTF-8 JSON");
  }
  const parsed = WarmDerivedSnapshotReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("warm derived snapshot receipt schema validation failed");
  }
  return parsed.data;
}

function assertSourceBinding(
  receipt: z.infer<typeof WarmDerivedSnapshotReceiptSchema>,
  input: { readonly sourceSnapshotDbSha256: string; readonly sourceSchemaVersion: number }
): void {
  const report = receipt.derived_evidence_projection_rebuild;
  if (receipt.source_snapshot_db_sha256 !== input.sourceSnapshotDbSha256 ||
      report.input_db_sha256 !== input.sourceSnapshotDbSha256) {
    throw new Error("warm derived snapshot source snapshot SHA-256 binding mismatch");
  }
  if (report.source_schema_version !== input.sourceSchemaVersion) {
    throw new Error("warm derived snapshot source schema binding mismatch");
  }
}

function resolveDatabasePath(receiptPath: string, databasePath: string): string {
  if (isAbsolute(databasePath)) {
    throw new Error("warm derived snapshot database path must be relative");
  }
  const receiptRoot = resolve(dirname(receiptPath));
  const resolvedPath = resolve(receiptRoot, databasePath);
  assertPathWithinReceipt(receiptRoot, resolvedPath);
  const physicalRoot = realpathSync(receiptRoot);
  const physicalPath = realpathSync(resolvedPath);
  assertPathWithinReceipt(physicalRoot, physicalPath);
  return physicalPath;
}

function assertPathWithinReceipt(receiptRoot: string, databasePath: string): void {
  const pathWithinReceipt = relative(receiptRoot, databasePath);
  if (pathWithinReceipt !== "" && !pathWithinReceipt.startsWith("..") &&
      !isAbsolute(pathWithinReceipt)) return;
  throw new Error(
    "warm derived snapshot database path must stay within the receipt directory"
  );
}

function freezeReport(
  report: z.infer<typeof RebuildReportSchema>
): EvidenceSearchProjectionRebuildReport {
  return Object.freeze({
    ...report,
    projection_kind_counts: Object.freeze(
      report.projection_kind_counts.map((entry) => Object.freeze(entry))
    ),
    ...(report.fact_frame_retrofit === undefined
      ? {}
      : { fact_frame_retrofit: Object.freeze(report.fact_frame_retrofit) })
  }) as EvidenceSearchProjectionRebuildReport;
}
