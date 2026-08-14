import { isValidMonthDay, monthIndexFromName } from "./month-names.js";

export interface CalendarSurfaceHit {
  readonly surface: string;
  readonly month: number;
  readonly day: number | null;
  readonly year: number | null;
}

export interface RelativeSurfaceHit {
  readonly surface: string;
  readonly count: number;
  readonly unit: "day" | "week" | "month" | "year";
}

const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gu;
const ENGLISH_DATE =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/giu;
const CJK_MD = /(\d{1,2})月(\d{1,2})日/gu;
const CJK_YMD = /(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/gu;
const RELATIVE_EN = /\b(\d{1,3})\s+(days?|weeks?|months?|years?)\s+ago\b/giu;
const RELATIVE_ZH = /(\d{1,3})(天|周|个月|年)前/gu;

export function extractCalendarSurfaces(text: string): readonly CalendarSurfaceHit[] {
  return Object.freeze([
    ...matchSlashDates(text),
    ...matchEnglishDates(text),
    ...matchCjkDates(text)
  ]);
}

export function extractRelativeSurfaces(text: string): readonly RelativeSurfaceHit[] {
  return Object.freeze([...matchRelativeEnglish(text), ...matchRelativeCjk(text)]);
}

function matchSlashDates(text: string): readonly CalendarSurfaceHit[] {
  return [...text.matchAll(SLASH_DATE)].flatMap((match) => {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const parsed = slashMonthDay(first, second);
    if (parsed === null || match[0] === undefined) return [];
    return [{
      surface: match[0],
      month: parsed.month,
      day: parsed.day,
      year: parseOptionalYear(match[3])
    }];
  });
}

function slashMonthDay(first: number, second: number): { month: number; day: number } | null {
  if (first > 12 && isValidMonthDay(second, first)) return { month: second, day: first };
  return isValidMonthDay(first, second) ? { month: first, day: second } : null;
}

function matchEnglishDates(text: string): readonly CalendarSurfaceHit[] {
  return [...text.matchAll(ENGLISH_DATE)].flatMap((match) => {
    const month = monthIndexFromName(match[1] ?? "");
    const day = Number(match[2]);
    if (month === null || !isValidMonthDay(month, day) || match[0] === undefined) return [];
    return [{ surface: match[0], month, day, year: parseOptionalYear(match[3]) }];
  });
}

function matchCjkDates(text: string): readonly CalendarSurfaceHit[] {
  const ymd = [...text.matchAll(CJK_YMD)].flatMap((match) => {
    const month = Number(match[2]);
    const day = match[3] === undefined ? null : Number(match[3]);
    if (month < 1 || month > 12 || match[0] === undefined) return [];
    if (day !== null && !isValidMonthDay(month, day)) return [];
    return [{ surface: match[0], month, day, year: Number(match[1]) }];
  });
  const md = [...text.matchAll(CJK_MD)].flatMap((match) => {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (!isValidMonthDay(month, day) || match[0] === undefined) return [];
    return [{ surface: match[0], month, day, year: null }];
  });
  return [...ymd, ...md];
}

function matchRelativeEnglish(text: string): readonly RelativeSurfaceHit[] {
  return [...text.matchAll(RELATIVE_EN)].flatMap((match) => {
    const unit = relativeUnit(match[2] ?? "");
    if (unit === null || match[0] === undefined) return [];
    return [{ surface: match[0], count: Number(match[1]), unit }];
  });
}

function matchRelativeCjk(text: string): readonly RelativeSurfaceHit[] {
  return [...text.matchAll(RELATIVE_ZH)].flatMap((match) => {
    const unit = relativeUnit(match[2] ?? "");
    if (unit === null || match[0] === undefined) return [];
    return [{ surface: match[0], count: Number(match[1]), unit }];
  });
}

function relativeUnit(token: string): RelativeSurfaceHit["unit"] | null {
  if (token.startsWith("day") || token === "天") return "day";
  if (token.startsWith("week") || token === "周") return "week";
  if (token.startsWith("month") || token === "个月") return "month";
  if (token.startsWith("year") || token === "年") return "year";
  return null;
}

function parseOptionalYear(value: string | undefined): number | null {
  if (value === undefined) return null;
  const year = Number(value);
  return year >= 1000 && year <= 9999 ? year : null;
}
