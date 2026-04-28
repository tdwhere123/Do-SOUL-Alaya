import type { OntologyRecord } from "../ontology/types.js";
import type { AuditedMutationRecord } from "../runtime/audit-types.js";
import type { JsonObject } from "../runtime/json.js";

export const portableBundleSchemaVersion = 1;
export const portableManifestVersion = 1;
export const portableIntegrityAlgorithm = "sha256";

export type PortableProfileScopeKind = "user" | "project";

export interface PortableSourceRef {
  readonly source_ref: string;
  readonly source_kind: string;
  readonly target_object_ids: readonly string[];
  readonly captured_at: string;
  readonly summary: string | null;
}

export interface PortableProfileScopeSnapshot {
  readonly scope_id: string;
  readonly scope_kind: PortableProfileScopeKind;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
  readonly governance_audit_refs: readonly string[];
  readonly settings: JsonObject;
}

export type RuntimeArtifactKind =
  | "activation_candidate"
  | "benchmark_view"
  | "context_pack"
  | "graph_view"
  | "inspector_state"
  | "working_projection";

export interface PortableRuntimeArtifactExclusion {
  readonly artifact_id: string;
  readonly artifact_kind: RuntimeArtifactKind;
  readonly reason: string;
}

export interface PortableBundlePayload {
  readonly ontology_records: readonly OntologyRecord[];
  readonly source_refs: readonly PortableSourceRef[];
  readonly governance_audit: readonly AuditedMutationRecord[];
  readonly profile_scopes: readonly PortableProfileScopeSnapshot[];
}

export interface PortableBundleManifestCounts {
  readonly ontology_records: number;
  readonly evidence_capsules: number;
  readonly memory_entries: number;
  readonly synthesis_capsules: number;
  readonly claim_forms: number;
  readonly governance_audit_records: number;
  readonly profile_scopes: number;
}

export interface PortableBundleManifest {
  readonly manifest_version: typeof portableManifestVersion;
  readonly schema_version: typeof portableBundleSchemaVersion;
  readonly bundle_id: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly profile_scope_id: string;
  readonly counts: PortableBundleManifestCounts;
  readonly ontology_object_ids: readonly string[];
  readonly evidence_object_ids: readonly string[];
  readonly governance_audit_event_ids: readonly string[];
  readonly source_refs: readonly string[];
  readonly profile_scope_ids: readonly string[];
  readonly excluded_runtime_artifact_count: number;
  readonly payload_sha256: string;
}

export interface PortableBundleIntegrity {
  readonly algorithm: typeof portableIntegrityAlgorithm;
  readonly payload_sha256: string;
}

export interface PortableBundleMetadata {
  readonly bundle_id: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly profile_scope_id: string;
  readonly excluded_runtime_artifacts: readonly PortableRuntimeArtifactExclusion[];
}

export interface PortableBundle {
  readonly kind: "alaya.portable_bundle";
  readonly schema_version: typeof portableBundleSchemaVersion;
  readonly metadata: PortableBundleMetadata;
  readonly payload: PortableBundlePayload;
  readonly manifest: PortableBundleManifest;
  readonly integrity: PortableBundleIntegrity;
}

export interface CreatePortableBundleInput {
  readonly bundle_id: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly profile_scope_id: string;
  readonly ontology_records: readonly OntologyRecord[];
  readonly source_refs: readonly PortableSourceRef[];
  readonly governance_audit: readonly AuditedMutationRecord[];
  readonly profile_scopes: readonly PortableProfileScopeSnapshot[];
  readonly runtime_artifacts?: readonly PortableRuntimeArtifactExclusion[];
}

export type BackupResult = "created" | "restored" | "failed";

export interface BackupStorageSnapshot {
  readonly driver: "node:sqlite" | "unknown";
  readonly data_path_ref: string;
  readonly database_state: "initialized" | "unavailable";
}

export interface CreateBackupMetadataInput {
  readonly backup_id: string;
  readonly created_at: string;
  readonly actor: string;
  readonly reason: string;
  readonly result: BackupResult;
  readonly source_bundle: PortableBundle;
  readonly storage: BackupStorageSnapshot;
}

export interface BackupAuditEvent {
  readonly event_kind: `operations.backup.${BackupResult}`;
  readonly actor: string;
  readonly source_bundle_id: string;
  readonly result: BackupResult;
  readonly reason: string;
  readonly recorded_at: string;
  readonly durable_truth_written: false;
}

export interface PortableBackupMetadata {
  readonly schema_version: 1;
  readonly backup_id: string;
  readonly created_at: string;
  readonly actor: string;
  readonly reason: string;
  readonly result: BackupResult;
  readonly source_bundle_id: string;
  readonly profile_scope_id: string;
  readonly bundle_manifest: PortableBundleManifest;
  readonly integrity: PortableBundleIntegrity;
  readonly storage: BackupStorageSnapshot;
  readonly audit_event: BackupAuditEvent;
}

export type ProviderPosture = "missing" | "configured" | "enabled" | "disabled" | "degraded" | "unavailable";
export type SecretRefSourceType = "env" | "local_file" | "external";
export type SecretRefResolutionState = "available" | "missing" | "failed" | "unresolved";
export type AttachmentStatus = "available" | "attached" | "not_attached" | "failed" | "not_implemented";

export interface OperationsSecretRefStatus {
  readonly secret_ref: string;
  readonly source_type: SecretRefSourceType;
  readonly resolution_state: SecretRefResolutionState;
  readonly error_code?: string | null;
}

export interface OperationsProviderStatusInput {
  readonly provider_id: string | null;
  readonly provider_configured: boolean;
  readonly model_ref: string | null;
  readonly enabled: boolean;
  readonly storage_available: boolean;
  readonly disabled_reason?: string | null;
  readonly degraded_reason?: string | null;
  readonly secret_refs: readonly OperationsSecretRefStatus[];
}

export interface OperationsDataPathStatus {
  readonly source: "DATA_DIR" | "default" | "explicit";
  readonly path_ref: string;
}

export interface OperationsStorageStatusInput {
  readonly driver: "node:sqlite" | "unknown";
  readonly ready: boolean;
  readonly database_state: "initialized" | "unavailable";
}

export interface OperationsProfileScopeStatus {
  readonly scope_id: string;
  readonly scope_kind: PortableProfileScopeKind;
  readonly ready: boolean;
}

export interface OperationsProfileStatusInput {
  readonly ready: boolean;
  readonly scopes: readonly OperationsProfileScopeStatus[];
}

export interface OperationsHostPrereqStatus {
  readonly name: string;
  readonly required: boolean;
  readonly available: boolean;
  readonly reason?: string | null;
}

export interface OperationsBackupReadiness {
  readonly export_ready: boolean;
  readonly backup_ready: boolean;
  readonly last_backup_id: string | null;
}

export interface CreateOperationsStatusInput {
  readonly checked_at: string;
  readonly local_data_path: OperationsDataPathStatus;
  readonly storage: OperationsStorageStatusInput;
  readonly profile: OperationsProfileStatusInput;
  readonly provider: OperationsProviderStatusInput;
  readonly attachments: {
    readonly mcp: AttachmentStatus;
    readonly cli: AttachmentStatus;
  };
  readonly host_prereqs: readonly OperationsHostPrereqStatus[];
  readonly backup: OperationsBackupReadiness;
}

export interface OperationsSecretRefReport {
  readonly secret_ref: string;
  readonly source_type: SecretRefSourceType;
  readonly resolution_state: SecretRefResolutionState;
  readonly error_code: string | null;
}

export interface OperationsEmbeddingStatus {
  readonly embedding_enabled: boolean;
  readonly provider_configured: boolean;
  readonly model_ref: string | null;
  readonly storage_available: boolean;
  readonly effective_mode: "keyword_only" | "embedding_supplement" | "degraded";
  readonly degraded_reason: string | null;
}

export interface OperationsStatusReport {
  readonly schema_version: 1;
  readonly checked_at: string;
  readonly read_only: true;
  readonly durable_truth_written: false;
  readonly mutation_count: 0;
  readonly local_data_path: OperationsDataPathStatus;
  readonly storage: OperationsStorageStatusInput & {
    readonly status: "ok" | "failed";
  };
  readonly profile: OperationsProfileStatusInput & {
    readonly status: "ok" | "failed";
  };
  readonly provider: {
    readonly provider_id: string | null;
    readonly posture: ProviderPosture;
    readonly embedding: OperationsEmbeddingStatus;
    readonly secret_refs: readonly OperationsSecretRefReport[];
  };
  readonly attachments: CreateOperationsStatusInput["attachments"];
  readonly host_prereqs: readonly OperationsHostPrereqStatus[];
  readonly backup: OperationsBackupReadiness;
  readonly degraded_reasons: readonly string[];
}
