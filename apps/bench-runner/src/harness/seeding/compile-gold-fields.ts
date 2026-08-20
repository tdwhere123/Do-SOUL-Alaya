export function isGoldAuthorityFieldKey(key: string): boolean {
  return !key.startsWith("golden") && (
    key.startsWith("gold_") ||
    key.startsWith("gold-") ||
    /^gold[A-Z]/u.test(key)
  );
}

export function omitGoldPrefixedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitGoldPrefixedFields);
  if (typeof value !== "object" || value === null) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isGoldAuthorityFieldKey(key)) continue;
    next[key] = omitGoldPrefixedFields(child);
  }
  return next;
}
