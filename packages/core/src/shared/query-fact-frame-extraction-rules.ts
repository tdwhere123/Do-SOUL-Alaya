import {
  AssociativeFactFrameSchema,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type AssociativeFactSlotRole
} from "@do-soul/alaya-protocol";
import type {
  QueryFactFrameExtractionPort
} from
  "./query-fact-frame-extraction-port.js";
import {
  AUXILIARIES,
  BE_AUXILIARIES,
  CLAUSE_BOUNDARIES,
  WH_WORDS
} from "./fact-frame-grammar/clause-boundaries.js";
import { isCjkSegmentationCandidate, warmCjkSegmentation } from
  "./cjk-segmentation.js";
import { parseCjkInterrogativeFactFrame } from
  "./fact-frame-grammar/cjk-interrogative.js";
import {
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  type FactFrameSourceToken
} from "./fact-frame-grammar/source-text.js";
import { COPULAR_MEASURE_WORDS } from "./fact-frame-grammar/result-slots.js";

export {
  COPULAR_MEASURE_WORDS,
  isRuleBasedCopularMeasureValue,
  isRuleBasedCopularPredicate,
  isRuleBasedGenericSpeaker,
  isRuleBasedLocationResultValue
} from "./fact-frame-grammar/result-slots.js";

type SubjectSpan = Readonly<{
  readonly text: string;
  readonly startIndex: number;
  readonly nextIndex: number;
}>;

export type RuleBasedQueryOsfLayout = Readonly<{
  readonly value: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly subject: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly predicate: Readonly<{ surface: string; source_span: readonly [number, number] }>;
  readonly constraints: readonly Readonly<{
    surface: string; source_span: readonly [number, number]
  }>[];
}>;

type QueryFactFrameParseTrace = Readonly<{
  readonly frame: Readonly<AssociativeFactFrame>;
  readonly osfLayout: RuleBasedQueryOsfLayout | null;
}>;

export class RuleBasedQueryFactFrameExtractor
implements QueryFactFrameExtractionPort {
  public readonly operator_id = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;

  public async extract(
    query: string,
    options?: Readonly<{ readonly maxFrames?: number }>
  ): Promise<readonly Readonly<AssociativeFactFrame>[]> {
    if ((options?.maxFrames ?? 1) <= 0) return Object.freeze([]);
    if (isCjkSegmentationCandidate(query)) await warmCjkSegmentation();
    const trace = parseInterrogativeFactFrameTrace(query);
    return trace === null ? Object.freeze([]) : Object.freeze([trace.frame]);
  }
}

export function traceRuleBasedQueryFactFrame(
  query: string
): QueryFactFrameParseTrace | null {
  return parseInterrogativeFactFrameTrace(query);
}

function parseInterrogativeFactFrameTrace(query: string): QueryFactFrameParseTrace | null {
  const tokens = tokenizeFactFrameSource(query);
  if (tokens.length < 3) return null;
  if (!WH_WORDS.has(tokens[0]!.normalized)) {
    return parseCjkInterrogativeFactFrame(query, tokens);
  }
  const auxiliaryIndex = tokens.findIndex(
    (token, index) => index > 0 && AUXILIARIES.has(token.normalized)
  );
  if (auxiliaryIndex < 1 || auxiliaryIndex > MAX_VALUE_PREFIX_TOKENS) return null;
  const value = sliceFactFrameTokens(query, tokens, 0, auxiliaryIndex);
  const auxiliary = tokens[auxiliaryIndex]!.normalized;
  if (!BE_AUXILIARIES.has(auxiliary)) {
    return parseDoSupportFrame(query, tokens, auxiliaryIndex + 1, value, auxiliaryIndex);
  }
  const parsed = parseCopularFrame(query, tokens, auxiliaryIndex + 1, value);
  return parsed === null ? null : {
    frame: parsed,
    osfLayout: copularOsfLayout(query, tokens, auxiliaryIndex)
  };
}

function parseDoSupportFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  bodyStart: number,
  value: string,
  auxiliaryIndex: number
): QueryFactFrameParseTrace | null {
  const subject = takeSubject(query, tokens, bodyStart);
  if (subject === null) return null;
  const relationIndex = skipPreRelationQualifiers(tokens, subject.nextIndex);
  const relation = tokens[relationIndex];
  if (relation === undefined || !isOpenRelationToken(relation)) return null;
  const qualifiers = tokens.slice(subject.nextIndex, relationIndex).map(
    (token) => slot("qualifier", token.text)
  );
  if (qualifiers.length > MAX_QUALIFIER_TOKENS) return null;
  const parsed = frame([
    slot("value", value),
    slot("subject", subject.text),
    ...qualifiers,
    slot("relation", relation.text)
  ]);
  if (parsed === null) return null;
  return {
    frame: parsed,
    osfLayout: doSupportOsfLayout(query, tokens, auxiliaryIndex, subject, relationIndex)
  };
}

function doSupportOsfLayout(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  auxiliaryIndex: number,
  subject: SubjectSpan,
  relationIndex: number
): RuleBasedQueryOsfLayout | null {
  const valueTokens = tokens.slice(0, auxiliaryIndex);
  if (valueTokens.filter((token) => WH_WORDS.has(token.normalized)).length !== 1 ||
      valueTokens.some((token) => token.normalized === "and" || token.normalized === "or") ||
      relationIndex !== subject.nextIndex) {
    return null;
  }
  const constraints = doSupportTailConstraints(query, tokens, relationIndex, valueTokens);
  if (constraints === null) return null;
  const valueStart = tokens[0]!;
  const valueEnd = tokens[auxiliaryIndex - 1]!;
  const subjectStart = tokens[subject.startIndex]!;
  const subjectEnd = tokens[subject.nextIndex - 1]!;
  const predicate = tokens[relationIndex]!;
  return Object.freeze({
    value: span(query, valueStart.start, valueEnd.end),
    subject: span(query, subjectStart.start, subjectEnd.end),
    predicate: span(query, predicate.start, predicate.end),
    constraints
  });
}

function doSupportTailConstraints(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  relationIndex: number,
  valueTokens: readonly FactFrameSourceToken[]
): RuleBasedQueryOsfLayout["constraints"] | null {
  const tail = tokens.slice(relationIndex + 1);
  if (tail.length === 0) return Object.freeze([]);
  if (tail.length === 1 && TERMINAL_COMPLEMENT_MARKERS.has(tail[0]!.normalized)) {
    return Object.freeze([]);
  }
  if (valueTokens.length !== 1 || valueTokens[0]!.normalized !== "where") return null;
  const linkerIndex = tail.findIndex(({ normalized }) => TAIL_CONSTRAINT_LINKERS.has(normalized));
  if (linkerIndex < 1 || linkerIndex >= tail.length - 1 ||
      tail.slice(linkerIndex + 1).some(({ normalized }) =>
        TAIL_CONSTRAINT_LINKERS.has(normalized) || CLAUSE_BOUNDARIES.has(normalized))) {
    return null;
  }
  return Object.freeze([
    span(query, tail[0]!.start, tail[tail.length - 1]!.end)
  ]);
}

function span(query: string, start: number, end: number) {
  return Object.freeze({
    surface: query.slice(start, end),
    source_span: Object.freeze([start, end] as const)
  });
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
    slot("value", value), slot("subject", subject.text),
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
    slot("value", value), ...relations.map((token) => slot("relation", token.text)),
    slot("subject", subject.text)
  ]);
}

function copularOsfLayout(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  auxiliaryIndex: number
): RuleBasedQueryOsfLayout | null {
  const valueTokens = tokens.slice(0, auxiliaryIndex);
  const subjectTokens = tokens.slice(auxiliaryIndex + 1);
  if (!isCopularMeasureLayout(valueTokens, subjectTokens)) return null;
  const auxiliary = tokens[auxiliaryIndex]!;
  return Object.freeze({
    value: span(query, valueTokens[0]!.start, valueTokens[1]!.end),
    subject: span(query, subjectTokens[0]!.start, subjectTokens.at(-1)!.end),
    predicate: span(query, auxiliary.start, auxiliary.end),
    constraints: Object.freeze([])
  });
}

function isCopularMeasureLayout(
  valueTokens: readonly FactFrameSourceToken[],
  subjectTokens: readonly FactFrameSourceToken[]
): boolean {
  return valueTokens.length === 2 && valueTokens[0]!.normalized === "how" &&
    COPULAR_MEASURE_WORDS.has(valueTokens[1]!.normalized) &&
    subjectTokens.length >= 2 && subjectTokens.length <= MAX_COPULAR_SUBJECT_TOKENS &&
    !subjectTokens.some(({ normalized }) => NEGATIONS.has(normalized) ||
      CLAUSE_BOUNDARIES.has(normalized) || normalized === "and" || normalized === "or");
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
    startIndex: start,
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
const MAX_COPULAR_SUBJECT_TOKENS = 6;
const TERMINAL_COMPLEMENT_MARKERS: ReadonlySet<string> = new Set([
  "with", "about"
]);
const TAIL_CONSTRAINT_LINKERS: ReadonlySet<string> = new Set(["on"]);
const EMPTY_TOKEN: FactFrameSourceToken = Object.freeze({
  text: "", normalized: "", start: 0, end: 0
});
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
