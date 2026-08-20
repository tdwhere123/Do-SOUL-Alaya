import {
  CausalUsageKindSchema,
  DerivationJobStatusSchema,
  EffectDecisionSchema,
  FactorFamilySchema,
  ProjectionEraseSubjectKindSchema,
  ProjectionGenerationStatusSchema
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  readNonEmptyStringField,
  readRecord,
  type RowParser
} from "../shared/parse-row.js";
import type {
  FieldCausalUsageRow,
  FieldDerivationJobRow,
  FieldEraseBarrierRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldProjectionGenerationRow,
  FieldProjectionArtifactsRow,
  FieldProjectionPinRow,
  FieldProjectionPointerRow,
  FieldProofEffectRow,
  FieldSourceEvidenceBindingRow,
  FieldSourceRecordRow,
  FieldSourceSpanRow
} from "./ports.js";

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
      event_time: readNullableStringField(row, "event_time"),
      valid_from: readNullableStringField(row, "valid_from"),
      valid_to: readNullableStringField(row, "valid_to"),
      operator_id: readNonEmptyStringField(row, "operator_id"),
      source_body: readNullableStringField(row, "source_body")
    });
  }
};

export const fieldSourceEvidenceBindingParser: RowParser<FieldSourceEvidenceBindingRow> = {
  parse(value: unknown): FieldSourceEvidenceBindingRow {
    const row = readRecord(value, "source_record_evidence_ref");
    return Object.freeze({
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      record_id: readNonEmptyStringField(row, "record_id"),
      evidence_object_id: readNonEmptyStringField(row, "evidence_object_id")
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
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
    });
  }
};

export const fieldFactorDescriptorParser: RowParser<FieldFactorDescriptorRow> = {
  parse(value: unknown): FieldFactorDescriptorRow {
    const row = readRecord(value, "factor_descriptor");
    return Object.freeze({
      factor_id: readNonEmptyStringField(row, "factor_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      family: FactorFamilySchema.parse(readNonEmptyStringField(row, "family")),
      canonical_payload: readNullableStringField(row, "canonical_payload"),
      operator_id: readNonEmptyStringField(row, "operator_id"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
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
      operator_id: readNonEmptyStringField(row, "operator_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
    });
  }
};

export const fieldDerivationJobParser: RowParser<FieldDerivationJobRow> = {
  parse(value: unknown): FieldDerivationJobRow {
    const row = readRecord(value, "derivation_job");
    return Object.freeze({
      job_id: readNonEmptyStringField(row, "job_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      purpose: readNonEmptyStringField(row, "purpose"),
      operator_id: readNonEmptyStringField(row, "operator_id"),
      input_evidence_ids_json: readNonEmptyStringField(row, "input_evidence_ids_json"),
      status: DerivationJobStatusSchema.parse(readNonEmptyStringField(row, "status")),
      disposition: readNonEmptyStringField(row, "disposition"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
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
      operator_versions_json: readNonEmptyStringField(row, "operator_versions_json"),
      schema_version: readNonEmptyStringField(row, "schema_version"),
      input_event_frontier: readNonEmptyStringField(row, "input_event_frontier"),
      governance_frontier: readNonEmptyStringField(row, "governance_frontier"),
      status: ProjectionGenerationStatusSchema.parse(readNonEmptyStringField(row, "status")),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
    });
  }
};

export const fieldProjectionArtifactsParser: RowParser<FieldProjectionArtifactsRow> = {
  parse(value: unknown): FieldProjectionArtifactsRow {
    const row = readRecord(value, "projection_generation_artifacts");
    return Object.freeze({
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      generation_id: readNonEmptyStringField(row, "generation_id"),
      artifact_digest: readNonEmptyStringField(row, "artifact_digest"),
      artifacts_json: readNonEmptyStringField(row, "artifacts_json"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
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

export const fieldProjectionPinParser: RowParser<FieldProjectionPinRow> = {
  parse(value: unknown): FieldProjectionPinRow {
    const row = readRecord(value, "projection_pin");
    return Object.freeze({
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      generation_id: readNonEmptyStringField(row, "generation_id"),
      reader_id: readNonEmptyStringField(row, "reader_id"),
      pinned_at: readNonEmptyStringField(row, "pinned_at"),
      expires_at: readNonEmptyStringField(row, "expires_at"),
      released_at: readNullableStringField(row, "released_at")
    });
  }
};

export const fieldEraseBarrierParser: RowParser<FieldEraseBarrierRow> = {
  parse(value: unknown): FieldEraseBarrierRow {
    const row = readRecord(value, "projection_erase_barrier");
    return Object.freeze({
      identity: readNonEmptyStringField(row, "identity"),
      barrier_id: readNonEmptyStringField(row, "barrier_id"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      generation_id: readNullableStringField(row, "generation_id"),
      subject_kind: ProjectionEraseSubjectKindSchema.parse(
        readNonEmptyStringField(row, "subject_kind")
      ),
      subject_id: readNonEmptyStringField(row, "subject_id"),
      erased_at: readNonEmptyStringField(row, "erased_at")
    });
  }
};

export const fieldCausalUsageParser: RowParser<FieldCausalUsageRow> = {
  parse(value: unknown): FieldCausalUsageRow {
    const row = readRecord(value, "causal_usage_receipt");
    return Object.freeze({
      identity: readNonEmptyStringField(row, "identity"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      causal_key: readNonEmptyStringField(row, "causal_key"),
      occurred_at: readNonEmptyStringField(row, "occurred_at"),
      downstream_ref: readNonEmptyStringField(row, "downstream_ref"),
      weight: readFiniteNumberField(row, "weight"),
      scope: readNonEmptyStringField(row, "scope"),
      usage_kind: CausalUsageKindSchema.parse(readNonEmptyStringField(row, "usage_kind")),
      operator_id: readNonEmptyStringField(row, "operator_id"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
    });
  }
};

export const fieldProofEffectParser: RowParser<FieldProofEffectRow> = {
  parse(value: unknown): FieldProofEffectRow {
    const row = readRecord(value, "proof_effect_decision");
    return Object.freeze({
      schema_version: readProofEffectSchemaVersion(row),
      request_digest: readNonEmptyStringField(row, "request_digest"),
      workspace_id: readNonEmptyStringField(row, "workspace_id"),
      actor_id: readNonEmptyStringField(row, "actor_id"),
      run_id: readNonEmptyStringField(row, "run_id"),
      delivery_id: readNonEmptyStringField(row, "delivery_id"),
      action: readNonEmptyStringField(row, "action"),
      target: readNonEmptyStringField(row, "target"),
      scope: readNonEmptyStringField(row, "scope"),
      effective_as_of: readNonEmptyStringField(row, "effective_as_of"),
      decision: EffectDecisionSchema.parse(readNonEmptyStringField(row, "decision")),
      supporting_receipt_ids_json: readNonEmptyStringField(row, "supporting_receipt_ids_json"),
      supporting_proof_witnesses_json: readNonEmptyStringField(
        row,
        "supporting_proof_witnesses_json"
      ),
      governance_frontier: readNonEmptyStringField(row, "governance_frontier"),
      policy_operator_id: readNonEmptyStringField(row, "policy_operator_id"),
      policy_operator_version: readNonEmptyStringField(row, "policy_operator_version"),
      recorded_at: readNonEmptyStringField(row, "recorded_at")
    });
  }
};

function readProofEffectSchemaVersion(row: Record<string, unknown>): 2 {
  const value = readFiniteNumberField(row, "schema_version");
  if (value !== 2) {
    throw new StorageError("VALIDATION_FAILED", "proof effect schema version must be 2");
  }
  return 2;
}

export function persistFieldWrite<T>(run: () => T, label: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isSqliteConstraint(error, /UNIQUE/iu)) {
      throw new StorageError("CONFLICT", `${label} identity collision.`, error);
    }
    if (isSqliteConstraint(error, /CHECK|erased|pointer swap/iu)) {
      throw new StorageError("VALIDATION_FAILED", `${label} check failed.`, error);
    }
    throw new StorageError("QUERY_FAILED", `Failed to persist ${label}.`, error);
  }
}

export function persistFieldTransaction<T>(
  database: StorageDatabase,
  run: () => T,
  label: string
): T {
  return persistFieldWrite(() => {
    if (database.connection.inTransaction) return run();
    return database.connection.transaction(run).immediate();
  }, label);
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

function isSqliteConstraint(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}
