export function normalizeTemporalIsoString(value: string): string | null {
  const trimmed = value.trim();
  const calendar = parseStrictCalendarDateToUtcDay(trimmed);
  if (calendar !== null) {
    return calendar.toISOString();
  }
  if (hasInvalidCalendarPrefix(trimmed)) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseStrictCalendarDateToUtcDay(value: string): Date | null {
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(value);
  if (iso !== null) {
    return buildUtcDate(iso[1], iso[2], iso[3] ?? "1");
  }
  const chinese = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/u.exec(value);
  if (chinese !== null) {
    return buildUtcDate(chinese[1], chinese[2], chinese[3] ?? "1");
  }
  return null;
}

function hasInvalidCalendarPrefix(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  return match !== null && buildUtcDate(match[1], match[2], match[3]) === null;
}

function buildUtcDate(yearRaw: string, monthRaw: string, dayRaw: string): Date | null {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInUtcMonth(year, month)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
