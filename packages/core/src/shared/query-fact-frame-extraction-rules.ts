import {
  AssociativeFactFrameSchema,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import type {
  QueryFactFrameExtractionPort
} from
  "./query-fact-frame-extraction-port.js";
import {
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  type FactFrameSourceToken
} from "./fact-frame-grammar/source-text.js";

export const RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID =
  "rule_based_query_fact_frame_extractor_v1";

type SubjectSpan = Readonly<{
  readonly text: string;
  readonly nextIndex: number;
}>;

export class RuleBasedQueryFactFrameExtractor
implements QueryFactFrameExtractionPort {
  public readonly operator_id = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;

  public async extract(
    query: string,
    options?: Readonly<{ readonly maxFrames?: number }>
  ): Promise<readonly Readonly<AssociativeFactFrame>[]> {
    if ((options?.maxFrames ?? 1) <= 0) return Object.freeze([]);
    const frame = parseInterrogativeFactFrame(query);
    return frame === null ? Object.freeze([]) : Object.freeze([frame]);
  }
}

function parseInterrogativeFactFrame(query: string): Readonly<AssociativeFactFrame> | null {
  const tokens = tokenizeFactFrameSource(query);
  if (tokens.length < 3 || !WH_WORDS.has(tokens[0]!.normalized)) return null;
  const auxiliaryIndex = tokens.findIndex(
    (token, index) => index > 0 && AUXILIARIES.has(token.normalized)
  );
  if (auxiliaryIndex < 1 || auxiliaryIndex > MAX_VALUE_PREFIX_TOKENS) return null;
  const value = sliceFactFrameTokens(query, tokens, 0, auxiliaryIndex);
  const auxiliary = tokens[auxiliaryIndex]!.normalized;
  return BE_AUXILIARIES.has(auxiliary)
    ? parseCopularFrame(query, tokens, auxiliaryIndex + 1, value)
    : parseDoSupportFrame(query, tokens, auxiliaryIndex + 1, value);
}

function parseDoSupportFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  bodyStart: number,
  value: string
): Readonly<AssociativeFactFrame> | null {
  const subject = takeSubject(query, tokens, bodyStart);
  if (subject === null) return null;
  const relationIndex = skipPreRelationQualifiers(tokens, subject.nextIndex);
  const relation = tokens[relationIndex];
  if (relation === undefined || !isOpenRelationToken(relation)) return null;
  const qualifiers = tokens.slice(subject.nextIndex, relationIndex).map(
    (token) => slot("qualifier", token.text)
  );
  if (qualifiers.length > MAX_QUALIFIER_TOKENS) return null;
  return frame([
    slot("value", value),
    slot("subject", subject.text),
    ...qualifiers,
    slot("relation", relation.text)
  ]);
}

function parseCopularFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  bodyStart: number,
  value: string
): Readonly<AssociativeFactFrame> | null {
  if (tokens.slice(bodyStart).some((token) => NEGATIONS.has(token.normalized))) return null;
  const ofIndex = tokens.findIndex(
    (token, index) => index > bodyStart && token.normalized === "of"
  );
  if (ofIndex > bodyStart) {
    return parseRelationBeforeSubjectFrame(query, tokens, bodyStart, ofIndex, value);
  }
  const subject = takeSubject(query, tokens, bodyStart);
  if (subject === null) return null;
  if (isSubjectToken(tokens[subject.nextIndex] ?? EMPTY_TOKEN)) return null;
  const relations = selectRelationTokens(tokens, subject.nextIndex, tokens.length);
  if (relations.length === 0) return null;
  return frame([
    slot("value", value),
    slot("subject", subject.text),
    ...relations.map((token) => slot("relation", token.text))
  ]);
}

function parseRelationBeforeSubjectFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  relationStart: number,
  ofIndex: number,
  value: string
): Readonly<AssociativeFactFrame> | null {
  const relations = selectRelationTokens(tokens, relationStart, ofIndex);
  const subject = takeSubject(query, tokens, ofIndex + 1);
  if (relations.length === 0 || subject === null || subject.nextIndex !== tokens.length) {
    return null;
  }
  return frame([
    slot("value", value),
    ...relations.map((token) => slot("relation", token.text)),
    slot("subject", subject.text)
  ]);
}

function takeSubject(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const first = tokens[start];
  if (first === undefined || !isSubjectToken(first)) return null;
  if (SUBJECT_PRONOUNS.has(first.normalized) ||
      POSSESSIVE_DETERMINERS.has(first.normalized)) {
    return Object.freeze({ text: first.text, nextIndex: start + 1 });
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
    nextIndex: end
  });
}

function takeDeterminerSubject(
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
    nextIndex: end
  });
}

function selectRelationTokens(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  end: number
): readonly FactFrameSourceToken[] {
  const boundary = findBoundary(tokens, start, end, COPULAR_RELATION_BOUNDARIES);
  return tokens.slice(start, boundary)
    .filter(isRelationToken)
    .slice(0, MAX_RELATION_TOKENS);
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

function skipPreRelationQualifiers(
  tokens: readonly FactFrameSourceToken[],
  start: number
): number {
  let index = start;
  while (index < tokens.length && PRE_RELATION_QUALIFIERS.has(tokens[index]!.normalized)) {
    index += 1;
  }
  return index;
}

function isSubjectToken(token: FactFrameSourceToken): boolean {
  return SUBJECT_PRONOUNS.has(token.normalized) ||
    POSSESSIVE_DETERMINERS.has(token.normalized) ||
    SUBJECT_DETERMINERS.has(token.normalized) || isNamedSubjectToken(token);
}

function isNamedSubjectToken(token: FactFrameSourceToken): boolean {
  return /^\p{Lu}/u.test(token.text) || /^[#@]/u.test(token.text) ||
    /[_./-]/u.test(token.text);
}

function isRelationToken(token: FactFrameSourceToken): boolean {
  return isOpenRelationToken(token) && !AUXILIARIES.has(token.normalized);
}

function isOpenRelationToken(token: FactFrameSourceToken): boolean {
  return token.text.length > 1 && !FUNCTION_WORDS.has(token.normalized) &&
    !BE_AUXILIARIES.has(token.normalized) && !WH_WORDS.has(token.normalized);
}

function isNounPhraseBoundary(token: FactFrameSourceToken): boolean {
  return SUBJECT_PRONOUNS.has(token.normalized) ||
    NOUN_PHRASE_BOUNDARIES.has(token.normalized) ||
    AUXILIARIES.has(token.normalized);
}

function slot(role: AssociativeFactSlotRole, text: string): Readonly<AssociativeFactSlot> {
  return Object.freeze({ role, text });
}

function frame(slots: readonly Readonly<AssociativeFactSlot>[]): Readonly<AssociativeFactFrame> | null {
  const parsed = AssociativeFactFrameSchema.safeParse({
    schema_version: 1,
    slots
  });
  return parsed.success ? parsed.data : null;
}

const MAX_VALUE_PREFIX_TOKENS = 4;
const MAX_SUBJECT_TOKENS = 4;
const MAX_RELATION_TOKENS = 3;
const MAX_QUALIFIER_TOKENS = 3;
const EMPTY_TOKEN: FactFrameSourceToken = Object.freeze({
  text: "", normalized: "", start: 0, end: 0
});
const WH_WORDS: ReadonlySet<string> = new Set([
  "what", "which", "who", "whom", "where", "when", "why", "how"
]);
const BE_AUXILIARIES: ReadonlySet<string> = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being"
]);
const AUXILIARIES: ReadonlySet<string> = new Set([
  ...BE_AUXILIARIES,
  "do", "does", "did", "has", "have", "had", "can", "could", "will",
  "would", "shall", "should", "may", "might", "must"
]);
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "i", "you", "he", "she", "it", "we", "they"
]);
const POSSESSIVE_DETERMINERS: ReadonlySet<string> = new Set([
  "my", "your", "his", "her", "its", "our", "their"
]);
const SUBJECT_DETERMINERS: ReadonlySet<string> = new Set(["a", "an", "the"]);
const PRE_RELATION_QUALIFIERS: ReadonlySet<string> = new Set([
  "also", "ever", "never", "not", "originally", "currently", "recently",
  "usually", "always", "then"
]);
const NEGATIONS: ReadonlySet<string> = new Set(["not", "never"]);
const CLAUSE_BOUNDARIES: ReadonlySet<string> = new Set([
  "after", "before", "because", "if", "since", "that", "when", "where",
  "while", "who", "which", "until", "than"
]);
const NOUN_PHRASE_BOUNDARIES: ReadonlySet<string> = new Set([
  ...CLAUSE_BOUNDARIES,
  "of", "to", "for", "from", "in", "on", "at", "by", "with", "about",
  "into", "over", "under", "and", "or", "but"
]);
const COPULAR_RELATION_BOUNDARIES: ReadonlySet<string> =
  NOUN_PHRASE_BOUNDARIES;
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "to", "for", "from", "in", "on", "at", "by",
  "with", "about", "into", "over", "under", "and", "or", "but", "many",
  "much", "long", "often", "now", ...PRE_RELATION_QUALIFIERS,
  ...CLAUSE_BOUNDARIES
]);
