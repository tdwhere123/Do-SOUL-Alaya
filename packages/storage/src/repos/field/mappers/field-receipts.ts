import {
  AddressableSourceSpanSchema,
  DerivationJobReceiptSchema,
  FACTOR_INCIDENCE_OPERATOR_ID,
  FactorDescriptorSchema,
  FactorIncidenceSchema,
  FieldProjectionGenerationSchema,
  PROJECTION_GENERATION_OPERATOR_ID,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  fieldReceiptContractFields,
  type AddressableSourceSpan,
  type DerivationJobReceipt,
  type FactorDescriptor,
  type FactorIncidence,
  type FieldProjectionGeneration,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import type {
  FieldDerivationJobRow,
  FieldFactorDescriptorRow,
  FieldFactorIncidenceRow,
  FieldProjectionGenerationRow,
  FieldSourceRecordRow,
  FieldSourceSpanRow
} from "../ports.js";

export function sourceRecordFromRow(row: FieldSourceRecordRow): SourceRecordIdentity {
  return SourceRecordIdentitySchema.parse({
    ...fieldReceiptContractFields({
      identity: row.record_id,
      producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    source_id: row.source_id,
    source_version: row.source_version,
    content_digest: row.content_digest,
    evidence_object_id: row.evidence_object_id,
    recorded_at: row.recorded_at,
    event_time: row.event_time,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    operator_id: row.operator_id
  });
}

export function sourceSpanFromRow(row: FieldSourceSpanRow): AddressableSourceSpan {
  return AddressableSourceSpanSchema.parse({
    ...fieldReceiptContractFields({
      identity: row.span_id,
      producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      consumer: "factor_incidence"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    record_id: row.record_id,
    start_offset: row.start_offset,
    end_offset: row.end_offset,
    purpose: row.purpose,
    producer_version: row.producer_version,
    recorded_at: row.recorded_at
  });
}

export function factorFromRow(row: FieldFactorDescriptorRow): FactorDescriptor {
  return FactorDescriptorSchema.parse({
    ...fieldReceiptContractFields({
      identity: row.factor_id,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    family: row.family,
    canonical_payload: row.canonical_payload,
    operator_id: row.operator_id,
    recorded_at: row.recorded_at
  });
}

export function incidenceFromRow(row: FieldFactorIncidenceRow): FactorIncidence {
  return FactorIncidenceSchema.parse({
    ...fieldReceiptContractFields({
      identity: row.incidence_id,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    span_id: row.span_id,
    factor_id: row.factor_id,
    scope: row.scope,
    operator_id: row.operator_id,
    recorded_at: row.recorded_at
  });
}

export function jobFromRow(row: FieldDerivationJobRow): DerivationJobReceipt {
  return DerivationJobReceiptSchema.parse({
    ...fieldReceiptContractFields({
      identity: row.job_id,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    purpose: row.purpose,
    operator_id: row.operator_id,
    input_evidence_ids: JSON.parse(row.input_evidence_ids_json) as string[],
    status: row.status,
    disposition: row.disposition,
    recorded_at: row.recorded_at
  });
}

export function generationFromRow(row: FieldProjectionGenerationRow): FieldProjectionGeneration {
  return FieldProjectionGenerationSchema.parse({
    ...fieldReceiptContractFields({
      identity: row.generation_id,
      producer: PROJECTION_GENERATION_OPERATOR_ID,
      consumer: "activation",
      deletion_behavior: "rebuildable"
    }),
    schema_version: 1,
    workspace_id: row.workspace_id,
    generation_id: row.generation_id,
    operator_manifest_digest: row.operator_manifest_digest,
    operator_versions: parseOperatorVersions(row.operator_versions_json),
    field_schema_version: row.schema_version,
    input_event_frontier: row.input_event_frontier,
    governance_frontier: row.governance_frontier,
    status: row.status,
    recorded_at: row.recorded_at
  });
}

export function generationToRow(
  generation: FieldProjectionGeneration
): FieldProjectionGenerationRow {
  return {
    generation_id: generation.generation_id,
    workspace_id: generation.workspace_id,
    operator_manifest_digest: generation.operator_manifest_digest,
    operator_versions_json: JSON.stringify(generation.operator_versions),
    schema_version: generation.field_schema_version,
    input_event_frontier: generation.input_event_frontier,
    governance_frontier: generation.governance_frontier,
    status: generation.status,
    recorded_at: generation.recorded_at
  };
}

function parseOperatorVersions(
  json: string
): readonly (readonly [string, string])[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("operator versions must be an array");
  }
  return parsed.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("operator version tuple is invalid");
    }
    return [String(entry[0]), String(entry[1])] as const;
  });
}
