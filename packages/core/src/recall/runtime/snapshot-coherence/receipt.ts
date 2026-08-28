import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { classifySnapshotCoherence } from "./coherence-status.js";
import { digestSnapshotVectorV1 } from "./snapshot-vector.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import {
  rejectSnapshotCoherence,
  SNAPSHOT_COHERENCE_OPERATOR_ID,
  type RestrictedUniverseInput,
  type SnapshotCoherenceReceiptV1,
  type SnapshotVectorV1,
  type SourceFrontierDeclarationV1
} from "./types.js";

export function createSnapshotCoherenceReceiptV1(
  vector: SnapshotVectorV1,
  options: Readonly<{ readonly restricted_universe?: RestrictedUniverseInput }> = {}
): SnapshotCoherenceReceiptV1 {
  assertRestrictedUniverse(vector, options.restricted_universe);
  const classified = classifySnapshotCoherence(vector);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: SNAPSHOT_COHERENCE_OPERATOR_ID,
    principal: vector.principal,
    authorized_scopes: vector.authorized_scopes,
    effective_as_of: vector.effective_as_of,
    coherence_state: classified.state,
    reasons: classified.reasons,
    lag_bounds: classified.lag_bounds,
    vector_digest: digestSnapshotVectorV1(vector)
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestReceiptBody(body)
  });
}

export function verifySnapshotCoherenceReceiptV1(
  receipt: SnapshotCoherenceReceiptV1
): void {
  if (receipt.schema_version !== 1
    || receipt.operator_id !== SNAPSHOT_COHERENCE_OPERATOR_ID) {
    rejectSnapshotCoherence("malformed_digest");
  }
  if (digestSnapshotCoherenceReceiptV1(receipt) !== receipt.receipt_digest) {
    rejectSnapshotCoherence("malformed_digest");
  }
}

export function digestSnapshotCoherenceReceiptV1(
  receipt: SnapshotCoherenceReceiptV1
): RecallFieldDigest {
  return digestReceiptBody({
    schema_version: receipt.schema_version,
    operator_id: receipt.operator_id,
    principal: receipt.principal,
    authorized_scopes: receipt.authorized_scopes,
    effective_as_of: receipt.effective_as_of,
    coherence_state: receipt.coherence_state,
    reasons: receipt.reasons,
    lag_bounds: receipt.lag_bounds,
    vector_digest: receipt.vector_digest
  });
}

export function publicSnapshotCoherenceReceiptBytes(
  receipt: SnapshotCoherenceReceiptV1
): string {
  return stableStringify(receipt);
}

function digestReceiptBody(
  body: Omit<SnapshotCoherenceReceiptV1, "receipt_digest">
): RecallFieldDigest {
  return digestRecallFieldIdentity(body);
}

function assertRestrictedUniverse(
  vector: SnapshotVectorV1,
  restricted: RestrictedUniverseInput | undefined
): void {
  const owners = new Set(authorizedOwners(vector));
  for (const source of restricted?.sources ?? []) {
    const created = createSourceFrontierDeclaration(source);
    rejectRestrictedLeak(created, vector, owners);
    owners.add(created.source_owner);
  }
}

function rejectRestrictedLeak(
  created: SourceFrontierDeclarationV1,
  vector: SnapshotVectorV1,
  owners: ReadonlySet<string>
): void {
  if (owners.has(created.source_owner)) {
    rejectSnapshotCoherence("duplicate_source_owner");
  }
  if (created.principal !== vector.principal
    || vector.authorized_scopes.includes(created.authorized_scope)) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
}

function authorizedOwners(vector: SnapshotVectorV1): readonly string[] {
  return [
    vector.projection_generation.source_owner,
    ...vector.retrieval_channel_snapshots.map((source) => source.source_owner),
    vector.embedding_generation_and_model.source_owner,
    vector.path_graph_generation.source_owner,
    vector.temporal_index_generation.source_owner,
    vector.governance_frontier.source_owner
  ];
}
