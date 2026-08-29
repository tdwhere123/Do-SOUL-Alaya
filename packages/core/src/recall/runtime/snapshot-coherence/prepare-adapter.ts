import type { ProjectionPin, QueryConditionReceipt } from "@do-soul/alaya-protocol";
import { type RecallFieldDigest } from "../../field/field-identity.js";
import type { FieldPrefix } from "../../field/retrieval/retrieval-field-bundle.js";
import { isSnapshotDigest, unavailableProducerDigest } from "./digest.js";
import { createSnapshotCoherenceReceiptV1 } from "./receipt.js";
import { createSourceFrontierDeclaration } from "./source-frontier.js";
import { createSnapshotVectorV1 } from "./snapshot-vector.js";
import {
  rejectSnapshotCoherence,
  type RestrictedUniverseInput,
  type SnapshotCoherenceReceiptV1,
  type SnapshotVectorV1,
  type SourceFrontierDeclarationV1
} from "./types.js";

export const PREPARE_RETRIEVAL_CHANNEL_OWNERS: readonly FieldPrefix[] = Object.freeze([
  "lexical_relaxed",
  "lexical_expanded",
  "lexical_anchor",
  "evidence_fts",
  "synthesis_fts"
]);

type PreparedSnapshotCaptureInput = Readonly<{
  readonly queryCondition: QueryConditionReceipt;
  readonly pin: ProjectionPin;
  readonly snapshotDigest?: string;
  readonly retrieval_channel_owners?: readonly string[];
  readonly formation_operator_versions?: readonly (readonly [string, string])[];
  readonly restricted_universe?: RestrictedUniverseInput;
}>;

export function capturePreparedSnapshotCoherenceReceipt(
  input: PreparedSnapshotCaptureInput
): SnapshotCoherenceReceiptV1 {
  return createSnapshotCoherenceReceiptV1(capturePreparedSnapshotVector(input), {
    restricted_universe: input.restricted_universe
  });
}

export function capturePreparedSnapshotVector(
  input: PreparedSnapshotCaptureInput
): SnapshotVectorV1 {
  const { condition, scope } = pinnedCondition(input);
  const principal = condition.principal;
  return createSnapshotVectorV1({
    principal,
    authorized_scopes: condition.authorized_scopes,
    effective_as_of: condition.effective_as_of,
    // Prepare has no separate write-set frontier; the pin is the only declared generation.
    transaction_frontier: input.pin.generation_id,
    base_store_digest: declaredBaseDigest(input.snapshotDigest),
    projection_generation: declaredProjection(input, principal, scope),
    retrieval_channel_snapshots: declaredRetrieval(
      input.retrieval_channel_owners, principal, scope
    ),
    ...unavailableDerived(principal, scope),
    formation_operator_versions: input.formation_operator_versions ?? [],
    // Query identity binds the snapshot; it is not a store-frontier claim.
    decision_contract_digest: declaredDecisionContract(input.queryCondition.identity),
    restricted_universe: input.restricted_universe
  });
}

function pinnedCondition(input: PreparedSnapshotCaptureInput): Readonly<{
  readonly condition: QueryConditionReceipt["condition"];
  readonly scope: string;
}> {
  const condition = input.queryCondition.condition;
  if (input.pin.workspace_id !== condition.workspace_id) {
    rejectSnapshotCoherence("mismatched_principal_scope");
  }
  if (input.pin.generation_id !== input.queryCondition.generation_id) {
    rejectSnapshotCoherence("mixed_operator_generation");
  }
  const scope = condition.authorized_scopes[0];
  if (scope === undefined) rejectSnapshotCoherence("mismatched_principal_scope");
  return { condition, scope };
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

function declaredRetrieval(
  owners: readonly string[] | undefined,
  principal: string,
  scope: string
): readonly SourceFrontierDeclarationV1[] {
  if (owners === undefined || owners.length === 0) return [];
  // Present channels are named here; unexecuted search cannot claim exact.
  return owners.map((owner) => unavailableSource(owner, principal, scope));
}

function unavailableDerived(principal: string, scope: string) {
  return {
    embedding_generation_and_model: unavailableSource(
      "embedding_generation_and_model", principal, scope
    ),
    path_graph_generation: unavailableSource("path_graph_generation", principal, scope),
    temporal_index_generation: unavailableSource(
      "temporal_index_generation", principal, scope
    ),
    governance_frontier: unavailableSource("governance_frontier", principal, scope)
  };
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

function declaredDecisionContract(identity: string): RecallFieldDigest {
  if (!isSnapshotDigest(identity)) rejectSnapshotCoherence("malformed_digest");
  return identity;
}

function declaredBaseDigest(snapshotDigest: string | undefined): RecallFieldDigest {
  if (snapshotDigest === undefined) return unavailableProducerDigest("base_store");
  if (!isSnapshotDigest(snapshotDigest)) rejectSnapshotCoherence("malformed_digest");
  return snapshotDigest;
}
