export function selectOffsetLimitWindow<T>(
  items: readonly T[],
  opts: { readonly offset?: number; readonly limit?: number }
): readonly T[] {
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : items.length;
  return items.slice(offset, sliceEnd);
}
