import type { RecallFieldDigest } from "../../field/field-identity.js";

export const SNAPSHOT_COHERENCE_OPERATOR_ID = "recall_snapshot_coherence_v1" as const;

export const SNAPSHOT_COHERENCE_STATES = [
  "coherent_exact",
  "coherent_bounded",
  "incoherent",
  "unavailable"
] as const;

export type SnapshotCoherenceState = (typeof SNAPSHOT_COHERENCE_STATES)[number];

export type SnapshotCoherenceRejectCode =
  | "malformed_digest"
  | "duplicate_source_owner"
  | "mismatched_principal_scope"
  | "incompatible_base_frontier"
  | "mixed_operator_generation";

export class SnapshotCoherenceContractError extends Error {
  public readonly code: SnapshotCoherenceRejectCode;

  public constructor(code: SnapshotCoherenceRejectCode, message?: string) {
    super(message ?? code);
    this.name = "SnapshotCoherenceContractError";
    this.code = code;
  }
}

export function rejectSnapshotCoherence(
  code: SnapshotCoherenceRejectCode,
  message?: string
): never {
  throw new SnapshotCoherenceContractError(code, message ?? code);
}

export const RESERVED_SOURCE_OWNERS = [
  "projection_generation",
  "embedding_generation_and_model",
  "path_graph_generation",
  "temporal_index_generation",
  "governance_frontier",
  "formation_operator_versions"
] as const;

export type ReservedSourceOwner = (typeof RESERVED_SOURCE_OWNERS)[number];

export type SnapshotValidTimeDomainV1 =
  | { readonly kind: "bounded"; readonly from: string; readonly to: string }
  | { readonly kind: "open"; readonly from: string }
  | { readonly kind: "timeless" };

export type SnapshotLagBoundV1 =
  | { readonly kind: "exact" }
  | { readonly kind: "bounded"; readonly remaining_effect: string }
  | { readonly kind: "unavailable" };

export type SourceFrontierDeclarationV1 = Readonly<{
  readonly source_owner: string;
  readonly principal: string;
  readonly authorized_scope: string;
  readonly source_frontier: string;
  readonly valid_time_domain: SnapshotValidTimeDomainV1;
  readonly generation: string;
  readonly operator_or_model_version: string;
  readonly lag_bound: SnapshotLagBoundV1;
}>;

export type SnapshotVectorV1 = Readonly<{
  readonly schema_version: 1;
  readonly principal: string;
  readonly authorized_scopes: readonly string[];
  readonly effective_as_of: string;
  readonly transaction_frontier: string;
  readonly base_store_digest: RecallFieldDigest;
  readonly projection_generation: SourceFrontierDeclarationV1;
  readonly retrieval_channel_snapshots: readonly SourceFrontierDeclarationV1[];
  readonly embedding_generation_and_model: SourceFrontierDeclarationV1;
  readonly path_graph_generation: SourceFrontierDeclarationV1;
  readonly temporal_index_generation: SourceFrontierDeclarationV1;
  readonly governance_frontier: SourceFrontierDeclarationV1;
  readonly formation_operator_versions: readonly (readonly [string, string])[];
  readonly decision_contract_digest: RecallFieldDigest;
}>;

export type RestrictedUniverseInput = Readonly<{
  readonly sources?: readonly SourceFrontierDeclarationV1[];
}>;

export type SnapshotVectorV1Input = Omit<SnapshotVectorV1, "schema_version"> & Readonly<{
  readonly restricted_universe?: RestrictedUniverseInput;
}>;

export type SnapshotCoherenceReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SNAPSHOT_COHERENCE_OPERATOR_ID;
  readonly principal: string;
  readonly authorized_scopes: readonly string[];
  readonly effective_as_of: string;
  readonly coherence_state: SnapshotCoherenceState;
  readonly reasons: readonly string[];
  readonly lag_bounds: readonly string[];
  readonly vector_digest: RecallFieldDigest;
  readonly receipt_digest: RecallFieldDigest;
}>;
