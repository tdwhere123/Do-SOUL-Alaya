import { StorageError } from "../../shared/errors.js";
import {
  readNonEmptyStringField,
  readRecord,
  type RowParser
} from "../shared/parse-row.js";
import type {
  FieldCausalUsageKind,
  FieldCausalUsageRow,
  FieldDerivationJobRow,
  FieldDerivationJobStatus,
  FieldEraseBarrierRow,
  FieldEraseSubjectKind,
  FieldFactorDescriptorRow,
  FieldFactorFamily,
  FieldFactorIncidenceRow,
  FieldProjectionGenerationRow,
  FieldProjectionGenerationStatus,
  FieldProjectionPointerRow,
  FieldProofDecision,
  FieldProofEffectRow,
  FieldSourceRecordRow,
  FieldSourceSpanRow
} from "./ports.js";

const FACTOR_FAMILIES = new Set<FieldFactorFamily>(["f0", "f1", "f2", "f3"]);
const JOB_STATUSES = new Set<FieldDerivationJobStatus>([
  "nominated", "running", "succeeded", "failed", "abandoned"
]);
const GENERATION_STATUSES = new Set<FieldProjectionGenerationStatus>([
  "shadow", "verified", "active", "retired"
]);
const ERASE_KINDS = new Set<FieldEraseSubjectKind>([
  "source_record", "source_span", "factor", "incidence", "generation"
]);
const USAGE_KINDS = new Set<FieldCausalUsageKind>(["causal", "delivery", "inspection"]);
const DECISIONS = new Set<FieldProofDecision>([
  "allow", "deny", "defer", "require_confirmation"
]);

export const fieldSourceRecordParser: RowParser<FieldSourceRecordRow> = {
  parse(value: unknown): FieldSourceRecordRow {
    const row = readRecord(value, "source_record");
    return Object.freeze({
      record_id: readNonEmptyStringField(row, "record_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      source_id: readNonEmptyStringField(row, "source_id"),
      source_version: readNonEmptyStringField(row, "source_version"),
      content_digest: readNonEmptyStringField(row, "content_digest"),
      evidence_object_id: readNullableStringField(row, "evidence_object_id"),
      recorded_at: readNonEmptyStringField(row, "recorded_at"),
      operator_version: readNonEmptyStringField(row, "operator_version"),
      source_body: readNullableStringField(row, "source_body")
    });
  }
};

export const fieldSourceSpanParser: RowParser<FieldSourceSpanRow> = {
  parse(value: unknown): FieldSourceSpanRow {
    const row = readRecord(value, "source_span");
    return Object.freeze({
      span_id: readNonEmptyStringField(row, "span_id"),
      record_id: readNonEmptyStringField(row, "record_id"),
      start_offset: readIntegerField(row, "start_offset"),
      end_offset: readIntegerField(row, "end_offset"),
      purpose: readNonEmptyStringField(row, "purpose"),
      producer_version: readNonEmptyStringField(row, "producer_version"),
      workspace_id: readNonEmptyStringField(row, "workspace_id")
    });
  }
};

export const fieldFactorDescriptorParser: RowParser<FieldFactorDescriptorRow> = {
  parse(value: unknown): FieldFactorDescriptorRow {
    const row = readRecord(value, "factor_descriptor");
    return Object.freeze({
      factor_id: readNonEmptyStringField(row, "factor_id"),
      family: readEnumField(row, "family", FACTOR_FAMILIES),
      canonical_payload: readNullableStringField(row, "canonical_payload"),
      operator_version: readNonEmptyStringField(row, "operator_version")
    });
  }
};

export const fieldFactorIncidenceParser: RowParser<FieldFactorIncidenceRow> = {
  parse(value: unknown): FieldFactorIncidenceRow {
    const row = readRecord(value, "factor_incidence");
    return Object.freeze({
      incidence_id: readNonEmptyStringField(row, "incidence_id"),
      span_id: readNonEmptyStringField(row, "span_id"),
      factor_id: readNonEmptyStringField(row, "factor_id"),
      scope: readNonEmptyStringField(row, "scope"),
      operator_version: readNonEmptyStringField(row, "operator_version"),
      workspace_id: readNonEmptyStringField(row, "workspace_id")
    });
  }
};

export const fieldDerivationJobParser: RowParser<FieldDerivationJobRow> = {
  parse(value: unknown): FieldDerivationJobRow {
    const row = readRecord(value, "derivation_job");
    return Object.freeze({
      job_id: readNonEmptyStringField(row, "job_id"),
      purpose: readNonEmptyStringField(row, "purpose"),
      operator_version: readNonEmptyStringField(row, "operator_version"),
      input_evidence_ids_json: readNonEmptyStringField(row, "input_evidence_ids_json"),
      status: readEnumField(row, "status", JOB_STATUSES),
      disposition: readNonEmptyStringField(row, "disposition")
    });
  }
};

export const fieldProjectionGenerationParser: RowParser<FieldProjectionGenerationRow> = {
  parse(value: unknown): FieldProjectionGenerationRow {
    const row = readRecord(value, "projection_generation");
    return Object.freeze({
      generation_id: readNonEmptyStringField(row, "generation_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      operator_manifest_digest: readNonEmptyStringField(row, "operator_manifest_digest"),
      schema_version: readNonEmptyStringField(row, "schema_version"),
      input_event_frontier: readNonEmptyStringField(row, "input_event_frontier"),
      governance_frontier: readNonEmptyStringField(row, "governance_frontier"),
      status: readEnumField(row, "status", GENERATION_STATUSES)
    });
  }
};

export const fieldProjectionPointerParser: RowParser<FieldProjectionPointerRow> = {
  parse(value: unknown): FieldProjectionPointerRow {
    const row = readRecord(value, "projection_generation_pointer");
    return Object.freeze({
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      active_generation_id: readNonEmptyStringField(row, "active_generation_id"),
      activated_at: readNonEmptyStringField(row, "activated_at")
    });
  }
};

export const fieldEraseBarrierParser: RowParser<FieldEraseBarrierRow> = {
  parse(value: unknown): FieldEraseBarrierRow {
    const row = readRecord(value, "projection_erase_barrier");
    return Object.freeze({
      barrier_id: readNonEmptyStringField(row, "barrier_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      generation_id: readNullableStringField(row, "generation_id"),
      subject_kind: readEnumField(row, "subject_kind", ERASE_KINDS),
      subject_id: readNonEmptyStringField(row, "subject_id"),
      erased_at: readNonEmptyStringField(row, "erased_at")
    });
  }
};

export const fieldCausalUsageParser: RowParser<FieldCausalUsageRow> = {
  parse(value: unknown): FieldCausalUsageRow {
    const row = readRecord(value, "causal_usage_receipt");
    return Object.freeze({
      receipt_id: readNonEmptyStringField(row, "receipt_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      causal_key: readNonEmptyStringField(row, "causal_key"),
      occurred_at: readNonEmptyStringField(row, "occurred_at"),
      downstream_ref: readNonEmptyStringField(row, "downstream_ref"),
      weight: readFiniteNumberField(row, "weight"),
      scope: readNonEmptyStringField(row, "scope"),
      usage_kind: readEnumField(row, "usage_kind", USAGE_KINDS)
    });
  }
};

export const fieldProofEffectParser: RowParser<FieldProofEffectRow> = {
  parse(value: unknown): FieldProofEffectRow {
    const row = readRecord(value, "proof_effect_decision");
    return Object.freeze({
      request_digest: readNonEmptyStringField(row, "request_digest"),
      action: readNonEmptyStringField(row, "action"),
      target: readNonEmptyStringField(row, "target"),
      scope: readNonEmptyStringField(row, "scope"),
      effective_as_of: readNonEmptyStringField(row, "effective_as_of"),
      decision: readEnumField(row, "decision", DECISIONS),
      supporting_receipt_ids_json: readNonEmptyStringField(row, "supporting_receipt_ids_json")
    });
  }
};

export function persistFieldWrite<T>(run: () => T, label: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isSqliteConstraint(error, /UNIQUE/iu)) {
      throw new StorageError("CONFLICT", `${label} identity collision.`, error);
    }
    if (isSqliteConstraint(error, /CHECK/iu)) {
      throw new StorageError("VALIDATION_FAILED", `${label} check failed.`, error);
    }
    throw new StorageError("QUERY_FAILED", `Failed to persist ${label}.`, error);
  }
}

export function insertIdempotent<T>(
  insert: () => void,
  read: () => T | null,
  same: (existing: T) => boolean,
  label: string
): T {
  return persistFieldWrite(() => {
    insert();
    const row = read();
    if (row === null) {
      throw new StorageError("QUERY_FAILED", `Failed to persist ${label}.`);
    }
    if (!same(row)) {
      throw new StorageError("CONFLICT", `${label} identity collision.`);
    }
    return row;
  }, label);
}

function readNullableStringField(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

function readIntegerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

function readFiniteNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

function readEnumField<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>
): T {
  const value = record[field];
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value as T;
}

function isSqliteConstraint(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}
