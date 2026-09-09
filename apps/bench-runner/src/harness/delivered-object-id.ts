export function hasObjectId<T extends { readonly object_id?: string }>(
  row: T
): row is T & { readonly object_id: string } {
  return typeof row.object_id === "string";
}

export function rowsWithObjectId<T extends { readonly object_id?: string }>(
  rows: readonly T[]
): ReadonlyArray<T & { readonly object_id: string }> {
  return rows.filter(hasObjectId);
}
