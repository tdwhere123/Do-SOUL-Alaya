import { cjkCardinal, englishCardinal } from "./numeric-words.js";

export interface NumericSurfaceHit {
  readonly surface: string;
  readonly value: number;
}

const DIGIT = /\b(0|[1-9]\d?)\b/gu;
const CJK_NUMERAL = /两|[零〇一二三四五六七八九十]{1,3}/gu;

const ENGLISH_BY_SURFACE = buildEnglishSurfaceMap();
const CJK_BY_SURFACE = buildCjkSurfaceMap();
const ENGLISH_PATTERN = new RegExp(
  `\\b(${[...ENGLISH_BY_SURFACE.keys()].sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|")})\\b`,
  "giu"
);

export function extractNumericSurfaces(text: string): readonly NumericSurfaceHit[] {
  return Object.freeze([
    ...matchPattern(text, DIGIT, Number),
    ...matchPattern(text, ENGLISH_PATTERN, parseEnglish),
    ...matchPattern(text, CJK_NUMERAL, parseCjk)
  ]);
}

function matchPattern(
  text: string,
  pattern: RegExp,
  parse: (surface: string) => number | null
): readonly NumericSurfaceHit[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].flatMap((match) => {
    const surface = match[0];
    if (surface === undefined) return [];
    const value = parse(surface);
    return value === null ? [] : [{ surface, value }];
  });
}

function parseEnglish(surface: string): number | null {
  return ENGLISH_BY_SURFACE.get(surface.toLowerCase()) ?? null;
}

function parseCjk(surface: string): number | null {
  return CJK_BY_SURFACE.get(surface) ?? null;
}

function buildEnglishSurfaceMap(): ReadonlyMap<string, number> {
  const entries = new Map<string, number>();
  for (let value = 0; value <= 99; value += 1) {
    const word = englishCardinal(value);
    if (word !== null) entries.set(word, value);
  }
  return entries;
}

function buildCjkSurfaceMap(): ReadonlyMap<string, number> {
  const entries = new Map<string, number>([["〇", 0], ["两", 2]]);
  for (let value = 0; value <= 99; value += 1) {
    const word = cjkCardinal(value);
    if (word !== null) entries.set(word, value);
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
