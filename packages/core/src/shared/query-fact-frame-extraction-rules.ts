import {
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  type AssociativeFactFrame
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
  EMPTY_TOKEN,
  MAX_QUALIFIER_TOKENS,
  MAX_VALUE_PREFIX_TOKENS,
  NEGATIONS,
  frame,
  isOpenRelationToken,
  isSubjectToken,
  selectRelationTokens,
  skipPreRelationQualifiers,
  slot,
  takeSubject,
  type SubjectSpan
} from "./fact-frame-grammar/english-clause-tokens.js";
import {
  isCopularMeasureLayout,
  parseCopularMeasureFrame,
  parseHowManyRelativeFrame,
  parseOfComplementFrame,
  parseUnmarkedWhVerbalFrame
} from "./fact-frame-grammar/english-recoverable-interrogatives.js";
import {
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  type FactFrameSourceToken
} from "./fact-frame-grammar/source-text.js";

export {
  COPULAR_MEASURE_WORDS,
  isRuleBasedCopularMeasureValue,
  isRuleBasedCopularPredicate,
  isRuleBasedGenericSpeaker,
  isRuleBasedLocationResultValue,
  SUBJECT_PRONOUNS
} from "./fact-frame-grammar/result-slots.js";

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
  if (auxiliaryIndex < 1 || auxiliaryIndex > MAX_VALUE_PREFIX_TOKENS) {
    const parsed = parseUnmarkedWhVerbalFrame(query, tokens) ??
      parseHowManyRelativeFrame(query, tokens);
    return parsed === null ? null : { frame: parsed, osfLayout: null };
  }
  const value = sliceFactFrameTokens(query, tokens, 0, auxiliaryIndex);
  const auxiliary = tokens[auxiliaryIndex]!.normalized;
  if (!BE_AUXILIARIES.has(auxiliary)) {
    return parseDoSupportFrame(query, tokens, auxiliaryIndex + 1, value, auxiliaryIndex);
  }
  const parsed = parseCopularFrame(query, tokens, auxiliaryIndex + 1, value) ??
    parseCopularMeasureFrame(query, tokens, auxiliaryIndex, value);
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
    return parseOfComplementFrame(query, tokens, bodyStart, ofIndex, value);
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

const TERMINAL_COMPLEMENT_MARKERS: ReadonlySet<string> = new Set([
  "with", "about"
]);
const TAIL_CONSTRAINT_LINKERS: ReadonlySet<string> = new Set(["on"]);
