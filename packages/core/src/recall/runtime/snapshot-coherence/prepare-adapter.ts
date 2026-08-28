import type { ProjectionPin, QueryConditionReceipt } from "@do-soul/alaya-protocol";
import {
  digestRecallFieldIdentity,
  isRecallFieldDigest,
  type RecallFieldDigest
} from "../../field/field-identity.js";
import { createSnapshotCoherenceReceiptV1 } from "./receipt.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import { createSnapshotVectorV1 } from "./snapshot-vector.js";
import {
  rejectSnapshotCoherence,
  type SnapshotCoherenceReceiptV1,
  type SourceFrontierDeclarationV1
} from "./types.js";

export function capturePreparedSnapshotCoherenceReceipt(input: Readonly<{
  readonly queryCondition: QueryConditionReceipt;
  readonly pin: ProjectionPin;
  readonly snapshotDigest?: string;
}>): SnapshotCoherenceReceiptV1 {
  const condition = input.queryCondition.condition;
  if (input.pin.workspace_id !== condition.workspace_id) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  if (input.pin.generation_id !== input.queryCondition.generation_id) {
    rejectSnapshotCoherence("mixed_operator_generation");
  }
  const scope = condition.authorized_scopes[0];
  if (scope === undefined) rejectSnapshotCoherence("mismatched_principal_scope");
  // Prepare has no separate write-set frontier; the pin is the only declared generation.
  const pinnedGeneration = input.pin.generation_id;
  const vector = createSnapshotVectorV1({
    principal: condition.principal,
    authorized_scopes: condition.authorized_scopes,
    effective_as_of: condition.effective_as_of,
    transaction_frontier: pinnedGeneration,
    base_store_digest: declaredBaseDigest(input.snapshotDigest),
    projection_generation: declaredProjection(input, condition.principal, scope),
    retrieval_channel_snapshots: [],
    embedding_generation_and_model: unavailableSource(
      "embedding_generation_and_model", condition.principal, scope
    ),
    path_graph_generation: unavailableSource(
      "path_graph_generation", condition.principal, scope
    ),
    temporal_index_generation: unavailableSource(
      "temporal_index_generation", condition.principal, scope
    ),
    governance_frontier: unavailableSource(
      "governance_frontier", condition.principal, scope
    ),
    formation_operator_versions: [],
    decision_contract_digest: digestRecallFieldIdentity({
      status: "producer_receipt_unavailable",
      owner: "decision_contract"
    })
  });
  return createSnapshotCoherenceReceiptV1(vector);
}

function declaredProjection(
  input: Readonly<{ readonly pin: ProjectionPin }>,
  principal: string,
  scope: string
): SourceFrontierDeclarationV1 {
  return createSourceFrontierDeclaration({
    source_owner: "projection_generation",
    principal,
    authorized_scope: scope,
    source_frontier: input.pin.generation_id,
    valid_time_domain: { kind: "timeless" },
    generation: input.pin.generation_id,
    operator_or_model_version: "projection_pin",
    lag_bound: { kind: "exact" }
  });
}

function unavailableSource(
  owner: string,
  principal: string,
  scope: string
): SourceFrontierDeclarationV1 {
  return createSourceFrontierDeclaration({
    source_owner: owner,
    principal,
    authorized_scope: scope,
    source_frontier: "unavailable",
    valid_time_domain: { kind: "timeless" },
    generation: "unavailable",
    operator_or_model_version: "unavailable",
    lag_bound: { kind: "unavailable" }
  });
}

function declaredBaseDigest(snapshotDigest: string | undefined): RecallFieldDigest {
  if (snapshotDigest === undefined) {
    return digestRecallFieldIdentity({
      status: "producer_receipt_unavailable",
      owner: "base_store"
    });
  }
  if (!isRecallFieldDigest(snapshotDigest)) {
    rejectSnapshotCoherence("malformed_digest");
  }
  return snapshotDigest;
}
