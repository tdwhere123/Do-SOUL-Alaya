import type {
  CausalUsageKind,
  DerivationJobStatus,
  EffectDecision,
  FactorFamily,
  ProjectionEraseSubjectKind,
  ProjectionGenerationPort,
  ProjectionGenerationStatus
} from "@do-soul/alaya-protocol";

export type FieldSourceRecordRow = Readonly<{
  readonly record_id: string;
  readonly workspace_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
  readonly recorded_at: string;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly operator_id: string;
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
  readonly recorded_at: string;
}>;

export type FieldSourceEvidenceBindingRow = Readonly<{
  readonly workspace_id: string;
  readonly record_id: string;
  readonly evidence_object_id: string;
}>;

export type FieldFactorDescriptorRow = Readonly<{
  readonly factor_id: string;
  readonly workspace_id: string;
  readonly family: FactorFamily;
  readonly canonical_payload: string | null;
  readonly operator_id: string;
  readonly recorded_at: string;
}>;

export type FieldFactorIncidenceRow = Readonly<{
  readonly incidence_id: string;
  readonly span_id: string;
  readonly factor_id: string;
  readonly scope: string;
  readonly operator_id: string;
  readonly workspace_id: string;
  readonly recorded_at: string;
}>;

export type FieldDerivationJobRow = Readonly<{
  readonly job_id: string;
  readonly workspace_id: string;
  readonly purpose: string;
  readonly operator_id: string;
  readonly input_evidence_ids_json: string;
  readonly status: DerivationJobStatus;
  readonly disposition: string;
  readonly recorded_at: string;
}>;

export type FieldProjectionGenerationRow = Readonly<{
  readonly generation_id: string;
  readonly workspace_id: string;
  readonly operator_manifest_digest: string;
  readonly operator_versions_json: string;
  readonly schema_version: string;
  readonly input_event_frontier: string;
  readonly governance_frontier: string;
  readonly status: ProjectionGenerationStatus;
  readonly recorded_at: string;
}>;

export type FieldProjectionPointerRow = Readonly<{
  readonly workspace_id: string;
  readonly active_generation_id: string;
  readonly activated_at: string;
}>;

export type FieldProjectionArtifactsRow = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly artifact_digest: string;
  readonly artifacts_json: string;
  readonly recorded_at: string;
}>;

export type FieldProjectionPinRow = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly reader_id: string;
  readonly pinned_at: string;
  readonly expires_at: string;
  readonly released_at: string | null;
}>;

export type FieldEraseBarrierRow = Readonly<{
  readonly identity: string;
  readonly barrier_id: string;
  readonly workspace_id: string;
  readonly generation_id: string | null;
  readonly subject_kind: ProjectionEraseSubjectKind;
  readonly subject_id: string;
  readonly erased_at: string;
}>;

export type FieldEraseBarrierInput = Omit<FieldEraseBarrierRow, "identity"> & Readonly<{
  readonly identity?: string;
}>;

export type FieldCausalUsageRow = Readonly<{
  readonly identity: string;
  readonly workspace_id: string;
  readonly causal_key: string;
  readonly occurred_at: string;
  readonly downstream_ref: string;
  readonly weight: number;
  readonly scope: string;
  readonly usage_kind: CausalUsageKind;
  readonly operator_id: string;
  readonly recorded_at: string;
}>;

export type FieldProofEffectRow = Readonly<{
  readonly schema_version: 2;
  readonly request_digest: string;
  readonly workspace_id: string;
  readonly actor_id: string;
  readonly run_id: string;
  readonly delivery_id: string;
  readonly action: string;
  readonly target: string;
  readonly scope: string;
  readonly effective_as_of: string;
  readonly decision: EffectDecision;
  readonly supporting_receipt_ids_json: string;
  readonly supporting_proof_witnesses_json: string;
  readonly governance_frontier: string;
  readonly policy_operator_id: string;
  readonly policy_operator_version: string;
  readonly recorded_at: string;
}>;

export interface FieldSourceRecordRepo {
  insert(row: FieldSourceRecordRow): FieldSourceRecordRow;
  findById(workspaceId: string, recordId: string): FieldSourceRecordRow | null;
  listByWorkspace(workspaceId: string): readonly FieldSourceRecordRow[];
  listEvidenceBindings(workspaceId: string): readonly FieldSourceEvidenceBindingRow[];
}

export interface FieldSourceSpanRepo {
  insert(row: FieldSourceSpanRow): FieldSourceSpanRow;
  findById(workspaceId: string, spanId: string): FieldSourceSpanRow | null;
  listByWorkspace(workspaceId: string): readonly FieldSourceSpanRow[];
}

export interface FieldFactorRepo {
  insertDescriptor(row: FieldFactorDescriptorRow): FieldFactorDescriptorRow;
  insertIncidence(row: FieldFactorIncidenceRow): FieldFactorIncidenceRow;
  findDescriptor(workspaceId: string, factorId: string): FieldFactorDescriptorRow | null;
  findIncidence(workspaceId: string, incidenceId: string): FieldFactorIncidenceRow | null;
  listDescriptors(workspaceId: string): readonly FieldFactorDescriptorRow[];
  listIncidences(workspaceId: string): readonly FieldFactorIncidenceRow[];
}

export interface FieldDerivationJobRepo {
  insert(row: FieldDerivationJobRow): FieldDerivationJobRow;
  persistStatus(
    workspaceId: string,
    jobId: string,
    expected: DerivationJobStatus,
    next: DerivationJobStatus
  ): FieldDerivationJobRow;
  findById(workspaceId: string, jobId: string): FieldDerivationJobRow | null;
}

export interface FieldProjectionGenerationRepo {
  insert(row: FieldProjectionGenerationRow): FieldProjectionGenerationRow;
  persistStatus(
    workspaceId: string,
    generationId: string,
    status: ProjectionGenerationStatus
  ): FieldProjectionGenerationRow;
  activatePointer(pointer: FieldProjectionPointerRow): FieldProjectionPointerRow;
  pin(pin: FieldProjectionPinRow): FieldProjectionPinRow;
  renewPin(input: Readonly<{
    readonly workspace_id: string;
    readonly generation_id: string;
    readonly reader_id: string;
    readonly renewed_at: string;
    readonly expires_at: string;
  }>): FieldProjectionPinRow;
  releasePin(input: Readonly<{
    readonly workspace_id: string;
    readonly generation_id: string;
    readonly reader_id: string;
    readonly released_at: string;
  }>): FieldProjectionPinRow;
  readPin(
    workspaceId: string,
    generationId: string,
    readerId: string
  ): FieldProjectionPinRow | null;
  collectRetired(workspaceId: string, asOf: string): readonly string[];
  putArtifacts(row: FieldProjectionArtifactsRow): FieldProjectionArtifactsRow;
  readArtifacts(workspaceId: string, generationId: string):
    FieldProjectionArtifactsRow | null;
  readActive(workspaceId: string): FieldProjectionGenerationRow | null;
  readPinned(workspaceId: string, generationId: string): FieldProjectionGenerationRow | null;
  readByGenerationIds(
    workspaceId: string,
    generationIds: readonly string[]
  ): readonly FieldProjectionGenerationRow[];
  asGenerationPort(): ProjectionGenerationPort;
}

export interface FieldEraseBarrierRepo {
  apply(row: FieldEraseBarrierInput): FieldEraseBarrierRow;
  findById(workspaceId: string, barrierId: string): FieldEraseBarrierRow | null;
}

export interface FieldCausalUsageRepo {
  insert(row: FieldCausalUsageRow): Readonly<{
    readonly row: FieldCausalUsageRow;
    readonly inserted: boolean;
  }>;
  findById(workspaceId: string, identity: string): FieldCausalUsageRow | null;
  listByWorkspaceAtAsOf(workspaceId: string, asOf: string): readonly FieldCausalUsageRow[];
}

export interface FieldProofEffectRepo {
  insert(row: FieldProofEffectRow): FieldProofEffectRow;
  findById(workspaceId: string, requestDigest: string): FieldProofEffectRow | null;
}
