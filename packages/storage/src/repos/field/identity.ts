import {
  FIELD_OPERATOR_MANIFEST,
  hashAddressableSourceSpanId,
  hashCausalUsageId,
  hashDerivationJobId,
  hashEffectRequestDigest,
  hashFactorId,
  hashGenerationId,
  hashIncidenceId,
  hashSourceRecordId,
  type FieldContractSha256,
  type FieldOperatorVersionEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import type {
  FieldCausalUsageRow,
  FieldDerivationJobRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldProjectionGenerationRow,
  FieldProofEffectRow,
  FieldSourceRecordRow,
  FieldSourceSpanRow
} from "./ports.js";

export function assertSubjectNotErased(
  database: StorageDatabase,
  workspaceId: string,
  subjectKind: "source_record" | "factor",
  subjectId: string
): void {
  const row = database.connection.prepare(`
    SELECT 1 AS present FROM projection_erase_barriers
    WHERE workspace_id = ? AND subject_kind = ? AND subject_id = ?
    LIMIT 1
  `).get(workspaceId, subjectKind, subjectId);
  if (row !== undefined) {
    throw new StorageError("CONFLICT", `${subjectKind} is erased`);
  }
}

export function verifyPersistedSourceRecord(
  row: FieldSourceRecordRow,
  sha256: FieldContractSha256
): void {
  assertHashed("source record", row.record_id, () => hashSourceRecordId(row, sha256));
}

export function verifyPersistedSourceSpan(
  row: FieldSourceSpanRow,
  sha256: FieldContractSha256
): void {
  assertHashed("source span", row.span_id, () => hashAddressableSourceSpanId(row, sha256));
}

export function verifyPersistedFactor(
  row: FieldFactorDescriptorRow,
  sha256: FieldContractSha256
): void {
  if (row.canonical_payload === null) return;
  assertHashed("factor", row.factor_id, () => hashFactorId({
    family: row.family,
    canonical_payload: row.canonical_payload,
    operator_id: row.operator_id
  }, sha256));
}

export function verifyPersistedIncidence(
  row: FieldFactorIncidenceRow,
  sha256: FieldContractSha256
): void {
  assertHashed("incidence", row.incidence_id, () => hashIncidenceId(row, sha256));
}

export function canonicalizeEvidenceIdsJson(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "job evidence ids must be JSON.", error);
  }
  if (!Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "job evidence ids must be an array.");
  }
  const ids = parsed.map((value) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new StorageError("VALIDATION_FAILED", "job evidence ids must be strings.");
    }
    return value;
  });
  return JSON.stringify([...ids].sort(compareCodeUnits));
}

export function verifyPersistedJob(
  row: FieldDerivationJobRow,
  sha256: FieldContractSha256
): void {
  const input_evidence_ids = JSON.parse(row.input_evidence_ids_json) as string[];
  assertHashed("derivation job", row.job_id, () => hashDerivationJobId({
    purpose: row.purpose,
    operator_id: row.operator_id,
    input_evidence_ids
  }, sha256));
}

export function verifyPersistedGeneration(
  row: FieldProjectionGenerationRow,
  sha256: FieldContractSha256
): void {
  const operators = parseOperatorVersions(row.operator_versions_json);
  if (!sameOperators(operators, FIELD_OPERATOR_MANIFEST)) {
    throw new StorageError("VALIDATION_FAILED", "projection generation operator list drift");
  }
  assertHashed("projection generation", row.generation_id, () => hashGenerationId({
    operators,
    operator_manifest_digest: row.operator_manifest_digest,
    field_schema_version: row.schema_version,
    input_event_frontier: row.input_event_frontier,
    governance_frontier: row.governance_frontier
  }, sha256));
}

export function verifyPersistedUsage(
  row: FieldCausalUsageRow,
  sha256: FieldContractSha256
): void {
  assertHashed("causal usage", row.identity, () => hashCausalUsageId(row, sha256));
}

export function verifyPersistedEffect(
  row: FieldProofEffectRow,
  sha256: FieldContractSha256
): void {
  const supporting_receipt_ids = JSON.parse(row.supporting_receipt_ids_json) as string[];
  assertHashed("proof effect", row.request_digest, () => hashEffectRequestDigest({
    action: row.action,
    target: row.target,
    scope: row.scope,
    effective_as_of: row.effective_as_of,
    supporting_receipt_ids
  }, sha256));
}

function assertHashed(label: string, actual: string, compute: () => string): void {
  let expected: string;
  try {
    expected = compute();
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `${label} identity mismatch.`, error);
  }
  if (actual !== expected) {
    throw new StorageError("VALIDATION_FAILED", `${label} identity mismatch.`);
  }
}

function parseOperatorVersions(json: string): readonly FieldOperatorVersionEntry[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "operator versions must be an array.");
  }
  return parsed.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new StorageError("VALIDATION_FAILED", "operator version tuple is invalid.");
    }
    return { id: String(entry[0]), version: String(entry[1]) };
  });
}

function sameOperators(
  actual: readonly FieldOperatorVersionEntry[],
  expected: readonly FieldOperatorVersionEntry[]
): boolean {
  return actual.length === expected.length &&
    actual.every((entry, index) =>
      entry.id === expected[index]?.id && entry.version === expected[index]?.version);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
