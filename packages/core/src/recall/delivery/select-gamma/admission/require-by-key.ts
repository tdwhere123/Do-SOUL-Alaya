export function requireByKey<T>(
  byKey: ReadonlyMap<string, T>,
  key: string,
  message: string
): T {
  const value = byKey.get(key);
  if (value === undefined) throw new Error(message);
  return value;
}
