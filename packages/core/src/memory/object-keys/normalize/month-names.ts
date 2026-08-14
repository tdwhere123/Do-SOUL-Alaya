export const ENGLISH_MONTHS = Object.freeze([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
] as const);

export const ENGLISH_MONTH_ABBREV = Object.freeze([
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec"
] as const);

export function monthIndexFromName(name: string): number | null {
  const normalized = name.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized === "sept") return 9;
  const long = ENGLISH_MONTHS.indexOf(normalized as typeof ENGLISH_MONTHS[number]);
  if (long >= 0) return long + 1;
  const short = ENGLISH_MONTH_ABBREV.indexOf(normalized as typeof ENGLISH_MONTH_ABBREV[number]);
  return short >= 0 ? short + 1 : null;
}

export function englishMonthName(month: number): string | null {
  return ENGLISH_MONTHS[month - 1] ?? null;
}

export function englishMonthAbbrev(month: number): string | null {
  return ENGLISH_MONTH_ABBREV[month - 1] ?? null;
}

export function isValidMonthDay(month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const lengths = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month] ?? 0);
}

export function titleCaseMonth(month: number): string | null {
  const name = englishMonthName(month);
  if (name === null) return null;
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}
