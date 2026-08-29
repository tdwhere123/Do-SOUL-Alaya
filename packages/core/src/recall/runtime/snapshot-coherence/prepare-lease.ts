import {
  bindSnapshotReadLease,
  finalizeSnapshotReadLease,
  openSnapshotReadLease,
  type SnapshotReadLeaseV1,
  type SnapshotReadLeaseViewKind
} from "./lease.js";
import { derivedSources } from "./sources.js";
import type { SnapshotVectorV1, SourceFrontierDeclarationV1 } from "./types.js";

export function finalizePreparedSnapshotReadLease(
  vector: SnapshotVectorV1
): SnapshotReadLeaseV1 {
  const opened = openSnapshotReadLease({
    principal: vector.principal,
    authorized_scopes: vector.authorized_scopes,
    effective_as_of: vector.effective_as_of
  });
  const bound = derivedSources(vector).reduce(
    (lease, source) => bindSnapshotReadLease(lease, {
      source_owner: source.source_owner,
      declaration: source,
      view_kind: viewKindFor(source)
    }),
    opened
  );
  return finalizeSnapshotReadLease(bound, vector);
}

function viewKindFor(source: SourceFrontierDeclarationV1): SnapshotReadLeaseViewKind {
  if (source.lag_bound.kind === "unavailable") return "unavailable";
  if (source.source_owner === "projection_generation") return "pinned";
  return "captured";
}
