import {
  digestRecallFieldIdentity,
  isRecallFieldDigest,
  type RecallFieldDigest
} from "../../field/field-identity.js";
import { admitRestrictedUniverse, derivedSources } from "./sources.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import {
  rejectSnapshotCoherence,
  RESERVED_SOURCE_OWNERS,
  type SnapshotVectorV1,
  type SnapshotVectorV1Input,
  type SourceFrontierDeclarationV1
} from "./types.js";

export function createSnapshotVectorV1(input: SnapshotVectorV1Input): SnapshotVectorV1 {
  const principal = requirePrincipal(input.principal);
  const authorized_scopes = freezeScopes(input.authorized_scopes);
  const reserved = freezeReserved(input, principal, authorized_scopes);
  const retrieval = freezeRetrieval(input.retrieval_channel_snapshots, principal, authorized_scopes);
  const sources = derivedSources({ ...reserved, retrieval_channel_snapshots: retrieval });
  assertUniqueOwners(sources);
  admitRestrictedUniverse(input.restricted_universe, sources, principal, authorized_scopes);
  assertCompatibleFrontiers(input.transaction_frontier, sources);
  const body = Object.freeze({
    schema_version: 1 as const,
    principal,
    authorized_scopes,
    effective_as_of: requireToken(input.effective_as_of, "mismatched_principal_scope"),
    transaction_frontier: requireToken(input.transaction_frontier, "incompatible_base_frontier"),
    base_store_digest: requireSha256(input.base_store_digest),
    ...reserved,
    retrieval_channel_snapshots: retrieval,
    formation_operator_versions: freezeFormation(input.formation_operator_versions),
    decision_contract_digest: requireSha256(input.decision_contract_digest)
  });
  return Object.freeze({
    ...body,
    vector_digest: digestSnapshotVectorV1(body)
  });
}

export function verifySnapshotVectorV1(vector: SnapshotVectorV1): void {
  const rebuilt = createSnapshotVectorV1(vector);
  if (rebuilt.vector_digest !== vector.vector_digest) {
    rejectSnapshotCoherence("malformed_digest");
  }
}

export function digestSnapshotVectorV1(
  vector: Omit<SnapshotVectorV1, "vector_digest">
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    schema_version: 1,
    principal: vector.principal,
    authorized_scopes: vector.authorized_scopes,
    effective_as_of: vector.effective_as_of,
    transaction_frontier: vector.transaction_frontier,
    base_store_digest: vector.base_store_digest,
    projection_generation: vector.projection_generation,
    retrieval_channel_snapshots: vector.retrieval_channel_snapshots,
    embedding_generation_and_model: vector.embedding_generation_and_model,
    path_graph_generation: vector.path_graph_generation,
    temporal_index_generation: vector.temporal_index_generation,
    governance_frontier: vector.governance_frontier,
    formation_operator_versions: vector.formation_operator_versions,
    decision_contract_digest: vector.decision_contract_digest
  });
}

function freezeReserved(
  input: SnapshotVectorV1Input,
  principal: string,
  scopes: readonly string[]
) {
  return Object.freeze({
    projection_generation: boundSlot(
      input.projection_generation, "projection_generation", principal, scopes
    ),
    embedding_generation_and_model: boundSlot(
      input.embedding_generation_and_model,
      "embedding_generation_and_model",
      principal,
      scopes
    ),
    path_graph_generation: boundSlot(
      input.path_graph_generation, "path_graph_generation", principal, scopes
    ),
    temporal_index_generation: boundSlot(
      input.temporal_index_generation, "temporal_index_generation", principal, scopes
    ),
    governance_frontier: boundSlot(
      input.governance_frontier, "governance_frontier", principal, scopes
    )
  });
}

function freezeRetrieval(
  snapshots: readonly SourceFrontierDeclarationV1[],
  principal: string,
  scopes: readonly string[]
): readonly SourceFrontierDeclarationV1[] {
  return Object.freeze(snapshots.map((snapshot) => {
    const created = bindAuthorized(createSourceFrontierDeclaration(snapshot), principal, scopes);
    if ((RESERVED_SOURCE_OWNERS as readonly string[]).includes(created.source_owner)) {
      rejectSnapshotCoherence("duplicate_source_owner");
    }
    return created;
  }).sort((left, right) => left.source_owner.localeCompare(right.source_owner)));
}

function boundSlot(
  input: SourceFrontierDeclarationV1,
  owner: string,
  principal: string,
  scopes: readonly string[]
): SourceFrontierDeclarationV1 {
  const created = createSourceFrontierDeclaration(input);
  if (created.source_owner !== owner) {
    rejectSnapshotCoherence("mixed_operator_generation");
  }
  return bindAuthorized(created, principal, scopes);
}

function bindAuthorized(
  declaration: SourceFrontierDeclarationV1,
  principal: string,
  scopes: readonly string[]
): SourceFrontierDeclarationV1 {
  if (declaration.principal !== principal || !scopes.includes(declaration.authorized_scope)) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  return declaration;
}

function assertUniqueOwners(sources: readonly SourceFrontierDeclarationV1[]): void {
  const owners = new Set<string>();
  for (const source of sources) {
    if (owners.has(source.source_owner)) rejectSnapshotCoherence("duplicate_source_owner");
    owners.add(source.source_owner);
  }
}

function assertCompatibleFrontiers(
  transactionFrontier: string,
  sources: readonly SourceFrontierDeclarationV1[]
): void {
  const frontier = requireToken(transactionFrontier, "incompatible_base_frontier");
  for (const source of sources) {
    if (source.lag_bound.kind === "unavailable") continue;
    if (source.source_frontier !== frontier) {
      rejectSnapshotCoherence("incompatible_base_frontier");
    }
  }
}

function freezeFormation(
  rows: readonly (readonly [string, string])[]
): readonly (readonly [string, string])[] {
  const seen = new Set<string>();
  return Object.freeze(rows.map(([id, version]) => {
    const frozen = Object.freeze([
      requireToken(id, "mixed_operator_generation"),
      requireToken(version, "mixed_operator_generation")
    ] as const);
    if (seen.has(frozen[0])) rejectSnapshotCoherence("mixed_operator_generation");
    seen.add(frozen[0]);
    return frozen;
  }));
}

function freezeScopes(scopes: readonly string[]): readonly string[] {
  if (scopes.length === 0) rejectSnapshotCoherence("mismatched_principal_scope");
  const frozen = Object.freeze(
    [...scopes]
      .map((scope) => requireToken(scope, "mismatched_principal_scope"))
      .sort((left, right) => left.localeCompare(right))
  );
  if (new Set(frozen).size !== frozen.length) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  return frozen;
}

function requirePrincipal(value: string): string {
  return requireToken(value, "mismatched_principal_scope");
}

function requireToken(
  value: string,
  code: Parameters<typeof rejectSnapshotCoherence>[0]
): string {
  if (value.length === 0 || value.trim() !== value) rejectSnapshotCoherence(code);
  return value;
}

function requireSha256(value: string): RecallFieldDigest {
  if (!isRecallFieldDigest(value)) rejectSnapshotCoherence("malformed_digest");
  return value;
}
