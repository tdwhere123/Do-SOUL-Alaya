import type { TemporalWindow } from "./temporal-window.js";

const DAY_MS = 86_400_000;
const ENGLISH_MONTH_INDEX: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
});
const ENGLISH_MONTH_YEAR_PATTERN =
  /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})$/iu;

export function parseAbsoluteTemporalWindow(
  term: string,
  offsetMinutes = 0
): TemporalWindow | null {
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(term);
  if (isoDay !== null) {
    return dayWindow(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]), offsetMinutes);
  }
  const slashDay = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u.exec(term);
  if (slashDay !== null) {
    return dayWindow(Number(slashDay[1]), Number(slashDay[2]), Number(slashDay[3]), offsetMinutes);
  }
  const isoMonth = /^(\d{4})-(\d{2})$/u.exec(term);
  if (isoMonth !== null) {
    return monthWindow(Number(isoMonth[1]), Number(isoMonth[2]), offsetMinutes);
  }
  const namedMonth = ENGLISH_MONTH_YEAR_PATTERN.exec(term);
  if (namedMonth !== null) {
    return monthWindow(
      Number(namedMonth[2]),
      ENGLISH_MONTH_INDEX[namedMonth[1]!.slice(0, 3).toLowerCase()] ?? 0,
      offsetMinutes
    );
  }
  const year = /^(\d{4})(?:年)?$/u.exec(term);
  if (year !== null) {
    return yearWindow(Number(year[1]), offsetMinutes);
  }
  const cjk = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/u.exec(term);
  if (cjk === null) {
    return null;
  }
  return cjk[3] === undefined
    ? monthWindow(Number(cjk[1]), Number(cjk[2]), offsetMinutes)
    : dayWindow(Number(cjk[1]), Number(cjk[2]), Number(cjk[3]), offsetMinutes);
}

function dayWindow(
  year: number,
  month: number,
  day: number,
  offsetMinutes: number
): TemporalWindow | null {
  if (!isSupportedYear(year) || !isValidCivilDate(year, month, day)) {
    return null;
  }
  const startMs = civilMidnightMs(year, month - 1, day, offsetMinutes);
  return { startMs, endMs: startMs + DAY_MS - 1, precision: "day" };
}

function monthWindow(year: number, month: number, offsetMinutes: number): TemporalWindow | null {
  if (!isSupportedYear(year) || month < 1 || month > 12) {
    return null;
  }
  const startMs = civilMidnightMs(year, month - 1, 1, offsetMinutes);
  const endMs = civilMidnightMs(year, month, 1, offsetMinutes) - 1;
  return { startMs, endMs, precision: "month" };
}

function yearWindow(year: number, offsetMinutes: number): TemporalWindow | null {
  if (!isSupportedYear(year)) {
    return null;
  }
  return {
    startMs: civilMidnightMs(year, 0, 1, offsetMinutes),
    endMs: civilMidnightMs(year + 1, 0, 1, offsetMinutes) - 1,
    precision: "year"
  };
}

function isSupportedYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1000 && year <= 9999;
}

function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const resolved = new Date(Date.UTC(year, month - 1, day));
  return resolved.getUTCFullYear() === year &&
    resolved.getUTCMonth() === month - 1 &&
    resolved.getUTCDate() === day;
}

function civilMidnightMs(year: number, month0: number, day: number, offsetMinutes: number): number {
  return Date.UTC(year, month0, day) - offsetMinutes * 60_000;
}
