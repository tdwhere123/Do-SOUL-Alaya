import {
  AssociativeFactFrameSchema,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import {
  AUXILIARIES,
  BE_AUXILIARIES,
  CLAUSE_BOUNDARIES,
  WH_WORDS
} from "./clause-boundaries.js";
import { SUBJECT_PRONOUNS } from "./result-slots.js";
import {
  sliceFactFrameTokens,
  type FactFrameSourceToken
} from "./source-text.js";

export type SubjectSpan = Readonly<{
  readonly text: string;
  readonly startIndex: number;
  readonly nextIndex: number;
}>;

export function takeSubject(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const first = tokens[start];
  if (first === undefined || !isSubjectToken(first)) return null;
  if (SUBJECT_PRONOUNS.has(first.normalized) ||
      POSSESSIVE_DETERMINERS.has(first.normalized)) {
    return Object.freeze({ text: first.text, startIndex: start, nextIndex: start + 1 });
  }
  if (SUBJECT_DETERMINERS.has(first.normalized)) {
    return takeDeterminerSubject(query, tokens, start);
  }
  let end = start + 1;
  while (end < tokens.length && end - start < MAX_SUBJECT_TOKENS &&
    isNamedSubjectToken(tokens[end]!)) {
    end += 1;
  }
  return Object.freeze({
    text: sliceFactFrameTokens(query, tokens, start, end),
    startIndex: start,
    nextIndex: end
  });
}

export function takeDeterminerSubject(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  let end = start + 1;
  while (end < tokens.length && end - start < MAX_SUBJECT_TOKENS &&
    !isNounPhraseBoundary(tokens[end]!)) {
    end += 1;
  }
  if (end === start + 1) return null;
  return Object.freeze({
    text: sliceFactFrameTokens(query, tokens, start, end),
    startIndex: start,
    nextIndex: end
  });
}

export function selectRelationTokens(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  end: number
): readonly FactFrameSourceToken[] {
  const boundary = findBoundary(tokens, start, end, COPULAR_RELATION_BOUNDARIES);
  return tokens.slice(start, boundary)
    .filter(isRelationToken)
    .slice(0, MAX_RELATION_TOKENS);
}

export function skipPreRelationQualifiers(
  tokens: readonly FactFrameSourceToken[],
  start: number
): number {
  let index = start;
  while (index < tokens.length && PRE_RELATION_QUALIFIERS.has(tokens[index]!.normalized)) {
    index += 1;
  }
  return index;
}

export function isSubjectToken(token: FactFrameSourceToken): boolean {
  return SUBJECT_PRONOUNS.has(token.normalized) ||
    POSSESSIVE_DETERMINERS.has(token.normalized) ||
    SUBJECT_DETERMINERS.has(token.normalized) || isNamedSubjectToken(token);
}

export function isNamedSubjectToken(token: FactFrameSourceToken): boolean {
  return /^\p{Lu}/u.test(token.text) || /^[#@]/u.test(token.text) ||
    /[_./-]/u.test(token.text);
}

export function isOpenRelationToken(token: FactFrameSourceToken): boolean {
  return token.text.length > 1 && !FUNCTION_WORDS.has(token.normalized) &&
    !BE_AUXILIARIES.has(token.normalized) && !WH_WORDS.has(token.normalized);
}

export function isNounPhraseBoundary(token: FactFrameSourceToken): boolean {
  return SUBJECT_PRONOUNS.has(token.normalized) ||
    NOUN_PHRASE_BOUNDARIES.has(token.normalized) ||
    AUXILIARIES.has(token.normalized);
}

export function slot(
  role: AssociativeFactSlotRole,
  text: string
): Readonly<AssociativeFactSlot> {
  return Object.freeze({ role, text });
}

export function frame(
  slots: readonly Readonly<AssociativeFactSlot>[]
): Readonly<AssociativeFactFrame> | null {
  const parsed = AssociativeFactFrameSchema.safeParse({
    schema_version: 1,
    slots
  });
  return parsed.success ? parsed.data : null;
}

function isRelationToken(token: FactFrameSourceToken): boolean {
  return isOpenRelationToken(token) && !AUXILIARIES.has(token.normalized);
}

function findBoundary(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  end: number,
  boundaries: ReadonlySet<string>
): number {
  for (let index = start; index < end; index += 1) {
    if (boundaries.has(tokens[index]!.normalized)) return index;
  }
  return end;
}

export const MAX_VALUE_PREFIX_TOKENS = 4;
export const MAX_SUBJECT_TOKENS = 4;
export const MAX_QUALIFIER_TOKENS = 3;
export const MAX_COPULAR_SUBJECT_TOKENS = 6;
export const EMPTY_TOKEN: FactFrameSourceToken = Object.freeze({
  text: "", normalized: "", start: 0, end: 0
});
export const POSSESSIVE_DETERMINERS: ReadonlySet<string> = new Set([
  "my", "your", "his", "her", "its", "our", "their"
]);
export const SUBJECT_DETERMINERS: ReadonlySet<string> = new Set(["a", "an", "the"]);
export const OBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "me", "him", "her", "us", "them"
]);
export const RELATIVE_MARKERS: ReadonlySet<string> = new Set(["that", "who", "which"]);
export const MEASURE_QUANTIFIERS: ReadonlySet<string> = new Set(["many", "much"]);
export const NEGATIONS: ReadonlySet<string> = new Set(["not", "never"]);
const MAX_RELATION_TOKENS = 3;
const PRE_RELATION_QUALIFIERS: ReadonlySet<string> = new Set([
  "also", "ever", "never", "not", "originally", "currently", "recently",
  "usually", "always", "then"
]);
const NOUN_PHRASE_BOUNDARIES: ReadonlySet<string> = new Set([
  ...CLAUSE_BOUNDARIES,
  "of", "to", "for", "from", "in", "on", "at", "by", "with", "about",
  "into", "over", "under", "and", "or", "but"
]);
const COPULAR_RELATION_BOUNDARIES: ReadonlySet<string> = NOUN_PHRASE_BOUNDARIES;
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "to", "for", "from", "in", "on", "at", "by",
  "with", "about", "into", "over", "under", "and", "or", "but", "many",
  "much", "long", "often", "now", ...PRE_RELATION_QUALIFIERS,
  ...CLAUSE_BOUNDARIES
]);
