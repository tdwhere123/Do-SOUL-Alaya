export class LegacyPathIndexUnboundError extends Error {
  public constructor(
    message = "Temporal path projection is populated but recall is bound to an empty legacy path_relations table."
  ) {
    super(message);
    this.name = "LegacyPathIndexUnboundError";
  }
}

export function isLegacyPathIndexUnboundError(error: unknown): boolean {
  // Worker serialization keeps `name` only; wrapping in StorageError degrades to storage_error (fail-safe).
  return error instanceof Error && error.name === "LegacyPathIndexUnboundError";
}

export type PathIndexReadFailureKind = "index_unbound" | "storage_fault";

export function classifyPathIndexReadFailure(error: unknown): PathIndexReadFailureKind {
  return isLegacyPathIndexUnboundError(error) ? "index_unbound" : "storage_fault";
}
