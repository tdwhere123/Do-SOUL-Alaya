export function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0;
}
