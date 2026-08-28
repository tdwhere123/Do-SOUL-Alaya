import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../../field/field-identity.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import {
  rejectSnapshotCoherence,
  RESERVED_SOURCE_OWNERS,
  type RestrictedUniverseInput,
  type SnapshotVectorV1,
  type SnapshotVectorV1Input,
  type SourceFrontierDeclarationV1
} from "./types.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function createSnapshotVectorV1(input: SnapshotVectorV1Input): SnapshotVectorV1 {
  const principal = requirePrincipal(input.principal);
  const authorized_scopes = freezeScopes(input.authorized_scopes);
  const reserved = freezeReserved(input, principal, authorized_scopes);
  const retrieval = freezeRetrieval(input.retrieval_channel_snapshots, principal, authorized_scopes);
  const sources = collectOwners(reserved, retrieval);
  assertUniqueOwners(sources);
  assertRestricted(input.restricted_universe, sources, authorized_scopes, principal);
  assertCompatibleFrontiers(input.transaction_frontier, sources);
  const vector = Object.freeze({
    schema_version: 1 as const,
    principal,
    authorized_scopes,
    effective_as_of: requireToken(input.effective_as_of),
    transaction_frontier: requireToken(input.transaction_frontier),
    base_store_digest: requireSha256(input.base_store_digest),
    ...reserved,
    retrieval_channel_snapshots: retrieval,
    formation_operator_versions: freezeFormation(input.formation_operator_versions),
    decision_contract_digest: requireSha256(input.decision_contract_digest)
  });
  return vector;
}

export function verifySnapshotVectorV1(vector: SnapshotVectorV1): void {
  const rebuilt = createSnapshotVectorV1(vector);
  if (digestSnapshotVectorV1(rebuilt) !== digestSnapshotVectorV1(vector)) {
    rejectSnapshotCoherence("malformed_digest");
  }
}

export function digestSnapshotVectorV1(vector: SnapshotVectorV1): RecallFieldDigest {
  return digestRecallFieldIdentity({
    schema_version: 1,
    principal: vector.principal,
    authorized_scopes: [...vector.authorized_scopes].sort(),
    effective_as_of: vector.effective_as_of,
    transaction_frontier: vector.transaction_frontier,
    base_store_digest: vector.base_store_digest,
    projection_generation: vector.projection_generation,
    retrieval_channel_snapshots: [...vector.retrieval_channel_snapshots]
      .slice()
      .sort((left, right) => left.source_owner.localeCompare(right.source_owner)),
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
  }));
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

function collectOwners(
  reserved: ReturnType<typeof freezeReserved>,
  retrieval: readonly SourceFrontierDeclarationV1[]
): readonly SourceFrontierDeclarationV1[] {
  return Object.freeze([
    reserved.projection_generation,
    ...retrieval,
    reserved.embedding_generation_and_model,
    reserved.path_graph_generation,
    reserved.temporal_index_generation,
    reserved.governance_frontier
  ]);
}

function assertUniqueOwners(sources: readonly SourceFrontierDeclarationV1[]): void {
  const owners = new Set<string>();
  for (const source of sources) {
    if (owners.has(source.source_owner)) rejectSnapshotCoherence("duplicate_source_owner");
    owners.add(source.source_owner);
  }
}

function assertRestricted(
  restricted: RestrictedUniverseInput | undefined,
  authorized: readonly SourceFrontierDeclarationV1[],
  scopes: readonly string[],
  principal: string
): void {
  const owners = new Set(authorized.map((source) => source.source_owner));
  for (const source of restricted?.sources ?? []) {
    const created = createSourceFrontierDeclaration(source);
    if (owners.has(created.source_owner)) rejectSnapshotCoherence("duplicate_source_owner");
    if (created.principal !== principal || scopes.includes(created.authorized_scope)) {
      rejectSnapshotCoherence("mismatched_principal_scope");
    }
    owners.add(created.source_owner);
  }
}

function assertCompatibleFrontiers(
  transactionFrontier: string,
  sources: readonly SourceFrontierDeclarationV1[]
): void {
  const frontier = requireToken(transactionFrontier);
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
    const frozen = Object.freeze([requireToken(id), requireToken(version)] as const);
    if (seen.has(frozen[0])) rejectSnapshotCoherence("mixed_operator_generation");
    seen.add(frozen[0]);
    return frozen;
  }));
}

function freezeScopes(scopes: readonly string[]): readonly string[] {
  if (scopes.length === 0) rejectSnapshotCoherence("mismatched_principal_scope");
  const frozen = Object.freeze(scopes.map((scope) => requireToken(scope)));
  if (new Set(frozen).size !== frozen.length) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  return frozen;
}

function requirePrincipal(value: string): string {
  return requireToken(value);
}

function requireToken(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  return value;
}

function requireSha256(value: string): RecallFieldDigest {
  if (!SHA256.test(value)) rejectSnapshotCoherence("malformed_digest");
  return value as RecallFieldDigest;
}
