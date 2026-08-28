import { createSourceFrontierDeclaration } from "./source-frontier.js";
import {
  rejectSnapshotCoherence,
  type RestrictedUniverseInput,
  type SnapshotVectorV1,
  type SourceFrontierDeclarationV1
} from "./types.js";

export function derivedSources(
  vector: Readonly<Pick<SnapshotVectorV1,
    | "projection_generation"
    | "retrieval_channel_snapshots"
    | "embedding_generation_and_model"
    | "path_graph_generation"
    | "temporal_index_generation"
    | "governance_frontier">>
): readonly SourceFrontierDeclarationV1[] {
  return Object.freeze([
    vector.projection_generation,
    ...vector.retrieval_channel_snapshots,
    vector.embedding_generation_and_model,
    vector.path_graph_generation,
    vector.temporal_index_generation,
    vector.governance_frontier
  ]);
}

export function admitRestrictedUniverse(
  restricted: RestrictedUniverseInput | undefined,
  authorized: readonly SourceFrontierDeclarationV1[],
  principal: string,
  scopes: readonly string[]
): void {
  const owners = new Set(authorized.map((source) => source.source_owner));
  for (const source of restricted?.sources ?? []) {
    const created = createSourceFrontierDeclaration(source);
    if (owners.has(created.source_owner)) {
      rejectSnapshotCoherence("duplicate_source_owner");
    }
    if (created.principal !== principal || scopes.includes(created.authorized_scope)) {
      rejectSnapshotCoherence("mismatched_principal_scope");
    }
    owners.add(created.source_owner);
  }
}
