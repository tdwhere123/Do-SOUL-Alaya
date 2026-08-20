export const HISTORY_ENTRY_SLUG_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}(?:-[a-z0-9](?:[a-z0-9-]{0,190}[a-z0-9])?)?$/;

export function isHistoryEntrySlug(slug: string): boolean {
  return HISTORY_ENTRY_SLUG_PATTERN.test(slug);
}
