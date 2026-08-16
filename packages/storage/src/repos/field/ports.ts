export type FieldSourceRecordRow = Readonly<{
  readonly record_id: string;
  readonly workspace_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
  readonly recorded_at: string;
  readonly operator_version: string;
  readonly source_body: string | null;
}>;

export type FieldSourceSpanRow = Readonly<{
  readonly span_id: string;
  readonly record_id: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly purpose: string;
  readonly producer_version: string;
  readonly workspace_id: string;
}>;

export type FieldFactorFamily = "f0" | "f1" | "f2" | "f3";

export type FieldFactorDescriptorRow = Readonly<{
  readonly factor_id: string;
  readonly family: FieldFactorFamily;
  readonly canonical_payload: string | null;
  readonly operator_version: string;
}>;

export type FieldFactorIncidenceRow = Readonly<{
  readonly incidence_id: string;
  readonly span_id: string;
  readonly factor_id: string;
  readonly scope: string;
  readonly operator_version: string;
  readonly workspace_id: string;
}>;

export type FieldDerivationJobStatus =
  | "nominated"
  | "running"
  | "succeeded"
  | "failed"
  | "abandoned";

export type FieldDerivationJobRow = Readonly<{
  readonly job_id: string;
  readonly purpose: string;
  readonly operator_version: string;
  readonly input_evidence_ids_json: string;
  readonly status: FieldDerivationJobStatus;
  readonly disposition: string;
}>;

export type FieldProjectionGenerationStatus = "shadow" | "verified" | "active" | "retired";

export type FieldProjectionGenerationRow = Readonly<{
  readonly generation_id: string;
  readonly workspace_id: string;
  readonly operator_manifest_digest: string;
  readonly schema_version: string;
  readonly input_event_frontier: string;
  readonly governance_frontier: string;
  readonly status: FieldProjectionGenerationStatus;
}>;

export type FieldProjectionPointerRow = Readonly<{
  readonly workspace_id: string;
  readonly active_generation_id: string;
  readonly activated_at: string;
}>;

export type FieldEraseSubjectKind =
  | "source_record"
  | "source_span"
  | "factor"
  | "incidence"
  | "generation";

export type FieldEraseBarrierRow = Readonly<{
  readonly barrier_id: string;
  readonly workspace_id: string;
  readonly generation_id: string | null;
  readonly subject_kind: FieldEraseSubjectKind;
  readonly subject_id: string;
  readonly erased_at: string;
}>;

export type FieldCausalUsageKind = "causal" | "delivery" | "inspection";

export type FieldCausalUsageRow = Readonly<{
  readonly receipt_id: string;
  readonly workspace_id: string;
  readonly causal_key: string;
  readonly occurred_at: string;
  readonly downstream_ref: string;
  readonly weight: number;
  readonly scope: string;
  readonly usage_kind: FieldCausalUsageKind;
}>;

export type FieldProofDecision = "allow" | "deny" | "defer" | "require_confirmation";

export type FieldProofEffectRow = Readonly<{
  readonly request_digest: string;
  readonly action: string;
  readonly target: string;
  readonly scope: string;
  readonly effective_as_of: string;
  readonly decision: FieldProofDecision;
  readonly supporting_receipt_ids_json: string;
}>;

export interface FieldSourceRecordRepo {
  insert(row: FieldSourceRecordRow): FieldSourceRecordRow;
  findById(recordId: string): FieldSourceRecordRow | null;
}

export interface FieldSourceSpanRepo {
  insert(row: FieldSourceSpanRow): FieldSourceSpanRow;
  findById(spanId: string): FieldSourceSpanRow | null;
}

export interface FieldFactorRepo {
  insertDescriptor(row: FieldFactorDescriptorRow): FieldFactorDescriptorRow;
  insertIncidence(row: FieldFactorIncidenceRow): FieldFactorIncidenceRow;
  findDescriptor(factorId: string): FieldFactorDescriptorRow | null;
  findIncidence(incidenceId: string): FieldFactorIncidenceRow | null;
}

export interface FieldDerivationJobRepo {
  insert(row: FieldDerivationJobRow): FieldDerivationJobRow;
  findById(jobId: string): FieldDerivationJobRow | null;
}

export interface FieldProjectionGenerationRepo {
  insert(row: FieldProjectionGenerationRow): FieldProjectionGenerationRow;
  persistStatus(
    generationId: string,
    status: FieldProjectionGenerationStatus
  ): FieldProjectionGenerationRow;
  activatePointer(pointer: FieldProjectionPointerRow): FieldProjectionPointerRow;
  readActive(workspaceId: string): FieldProjectionGenerationRow | null;
  readPinned(workspaceId: string, generationId: string): FieldProjectionGenerationRow | null;
  readByGenerationIds(
    workspaceId: string,
    generationIds: readonly string[]
  ): readonly FieldProjectionGenerationRow[];
}

export interface FieldEraseBarrierRepo {
  apply(row: FieldEraseBarrierRow): FieldEraseBarrierRow;
  findById(barrierId: string): FieldEraseBarrierRow | null;
}

export interface FieldCausalUsageRepo {
  insert(row: FieldCausalUsageRow): FieldCausalUsageRow;
  findById(receiptId: string): FieldCausalUsageRow | null;
}

export interface FieldProofEffectRepo {
  insert(row: FieldProofEffectRow): FieldProofEffectRow;
  findById(requestDigest: string): FieldProofEffectRow | null;
}
