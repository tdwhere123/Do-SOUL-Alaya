import { normalizeMemoryObjectKeySurface, type OpenSemanticFactor } from
  "@do-soul/alaya-protocol";
import {
  DURATION_AMOUNT_SOURCE,
  DURATION_UNIT_SOURCE,
  DURATION_VALUE_SOURCE,
  isDurationClassifierToken,
  normalizeDurationUnit,
  parseDurationAmount,
  type DurationUnit
} from "../../../../recall/query/duration-unit-family.js";
import { leftoverGenericSpeakerContentTokens } from "./subject.js";

export const OPEN_SEMANTIC_DURATION_MEASURE_OPERATOR_ID =
  "duration_measure_binding_v1" as const;

type ParsedDurationExtent = Readonly<{
  readonly amount: number;
  readonly unit: DurationUnit;
}>;
const SPACE_EXTENT = new RegExp(DURATION_VALUE_SOURCE, "giu");
const HYPHEN_EXTENT = new RegExp(
  String.raw`\b(?<amount>${DURATION_AMOUNT_SOURCE})-(?<unit>${DURATION_UNIT_SOURCE})\b`,
  "giu"
);
const AMOUNT_UNIT_LEXEME = new RegExp(
  String.raw`^(?<amount>${DURATION_AMOUNT_SOURCE})(?:\s+an|个)?(?:-|\s*)(?<unit>${DURATION_UNIT_SOURCE})$`,
  "iu"
);
const EXTENT_QUALIFIER_PREFIX =
  /^(?:over|under|about|around|nearly|more\s+than|less\s+than)\s+/iu;

export function parseDurationExtent(text: string): ParsedDurationExtent | null {
  const normalized = normalizeMemoryObjectKeySurface(text);
  if (/\b(?:ago|since|until)\b/u.test(normalized)) return null;
  const matches = [
    ...normalized.matchAll(new RegExp(SPACE_EXTENT.source, "giu")),
    ...normalized.matchAll(new RegExp(HYPHEN_EXTENT.source, "giu"))
  ].flatMap((match) => {
    const parsed = parseExtentMatch(match, normalized);
    return parsed === null ? [] : [parsed];
  });
  if (matches.length === 0) return null;
  const [first, ...rest] = matches;
  if (first === undefined || rest.some((item) => !sameExtent(first, item))) return null;
  return first;
}

export function isPureDurationExtentFactor(factor: Readonly<OpenSemanticFactor>): boolean {
  const parsed = parseDurationExtent(factor.surface) ??
    parseDurationExtent(factor.semantic_identity);
  if (parsed === null) return false;
  return leftoverContentTokens(factor.surface, parsed).length === 0 &&
    leftoverContentTokens(factor.semantic_identity, parsed).length === 0;
}

function parseExtentMatch(
  match: RegExpMatchArray,
  source: string
): ParsedDurationExtent | null {
  const matched = match[0] ?? "";
  const start = match.index ?? 0;
  if (/-old\b/u.test(source.slice(start, start + matched.length + 4))) return null;
  const captured = namedExtentGroups(match) ?? lexemeGroups(matched);
  const unit = normalizeDurationUnit(captured.unit ?? "");
  const numeric = parseDurationAmount(captured.amount ?? "");
  if (unit === undefined || numeric === null) return null;
  return Object.freeze({ amount: numeric, unit });
}

function namedExtentGroups(
  match: RegExpMatchArray
): Readonly<{ amount?: string; unit?: string }> | undefined {
  const groups = match.groups;
  if (groups?.amount === undefined || groups.unit === undefined) return undefined;
  return groups;
}

function lexemeGroups(lexeme: string): Readonly<{ amount?: string; unit?: string }> {
  const stripped = lexeme.replace(EXTENT_QUALIFIER_PREFIX, "");
  return AMOUNT_UNIT_LEXEME.exec(stripped)?.groups ?? {};
}

function leftoverContentTokens(
  text: string,
  extent: ParsedDurationExtent
): readonly string[] {
  return leftoverGenericSpeakerContentTokens(text).filter(
    (token) => !tokenCoversExtent(token, extent)
  );
}

function tokenCoversExtent(token: string, extent: ParsedDurationExtent): boolean {
  if (isDurationClassifierToken(token)) return true;
  if (parseDurationAmount(token) === extent.amount) return true;
  if (normalizeDurationUnit(token) === extent.unit) return true;
  const hyphen = `${extent.amount}-${extent.unit}`;
  if (token === hyphen || token === `${hyphen}s`) return true;
  const exact = AMOUNT_UNIT_LEXEME.exec(token);
  if (exact === null) return false;
  const parsed = parseExtentMatch(exact, token);
  return parsed !== null && sameExtent(parsed, extent);
}

function sameExtent(left: ParsedDurationExtent, right: ParsedDurationExtent): boolean {
  return left.amount === right.amount && left.unit === right.unit;
}
