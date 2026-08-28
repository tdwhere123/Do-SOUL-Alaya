import type {
  SnapshotVectorV1Input,
  SourceFrontierDeclarationV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";

export const SHA_A = `sha256:${"a".repeat(64)}` as const;
export const SHA_B = `sha256:${"b".repeat(64)}` as const;

export const PRINCIPAL = "principal-1";
export const SCOPE = "scope-authorized";
export const HIDDEN_SCOPE = "scope-hidden";
export const AS_OF = "2026-08-01T00:00:00.000Z";
export const TX_FRONTIER = "tx-frontier-1";
export const GENERATION = "gen-1";

export function declaration(
  overrides: Partial<SourceFrontierDeclarationV1> & Pick<SourceFrontierDeclarationV1, "source_owner">
): SourceFrontierDeclarationV1 {
  return {
    principal: PRINCIPAL,
    authorized_scope: SCOPE,
    source_frontier: TX_FRONTIER,
    valid_time_domain: { kind: "open", from: "2026-01-01T00:00:00.000Z" },
    generation: GENERATION,
    operator_or_model_version: "op-1",
    lag_bound: { kind: "exact" },
    ...overrides
  };
}

export function reservedDeclarations() {
  return {
    projection_generation: declaration({ source_owner: "projection_generation" }),
    embedding_generation_and_model: declaration({
      source_owner: "embedding_generation_and_model"
    }),
    path_graph_generation: declaration({ source_owner: "path_graph_generation" }),
    temporal_index_generation: declaration({ source_owner: "temporal_index_generation" }),
    governance_frontier: declaration({ source_owner: "governance_frontier" })
  };
}

export function exactVectorInput(
  overrides: Partial<SnapshotVectorV1Input> = {}
): SnapshotVectorV1Input {
  return {
    principal: PRINCIPAL,
    authorized_scopes: [SCOPE],
    effective_as_of: AS_OF,
    transaction_frontier: TX_FRONTIER,
    base_store_digest: SHA_A,
    ...reservedDeclarations(),
    retrieval_channel_snapshots: [
      declaration({ source_owner: "evidence_fts_exact" })
    ],
    formation_operator_versions: [["formation", "1"]],
    decision_contract_digest: SHA_B,
    ...overrides
  };
}
