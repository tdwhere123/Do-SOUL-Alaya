import type { AssociativeFactFrame, AssociativeFactSlot } from
  "@do-soul/alaya-protocol";
import {
  AUXILIARIES,
  CLAUSE_BOUNDARIES,
  WH_WORDS
} from "./clause-boundaries.js";
import { COPULAR_MEASURE_WORDS, SUBJECT_PRONOUNS } from "./result-slots.js";
import {
  EMPTY_TOKEN,
  FUNCTION_WORDS,
  MAX_COPULAR_SUBJECT_TOKENS,
  MAX_SUBJECT_TOKENS,
  MEASURE_QUANTIFIERS,
  NEGATIONS,
  OBJECT_PRONOUNS,
  POSSESSIVE_DETERMINERS,
  RELATIVE_MARKERS,
  frame,
  isNamedSubjectToken,
  isNounPhraseBoundary,
  isOpenRelationToken,
  selectRelationTokens,
  slot,
  takeDeterminerSubject,
  takeSubject,
  type SubjectSpan
} from "./english-clause-tokens.js";
import {
  sliceFactFrameTokens,
  type FactFrameSourceToken
} from "./source-text.js";

export function parseCopularMeasureFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  auxiliaryIndex: number,
  value: string
): Readonly<AssociativeFactFrame> | null {
  const valueTokens = tokens.slice(0, auxiliaryIndex);
  const subjectTokens = tokens.slice(auxiliaryIndex + 1);
  if (!isCopularMeasureLayout(valueTokens, subjectTokens)) return null;
  const locative = takeLocativeMeasureComplement(query, tokens, auxiliaryIndex + 1);
  if (locative !== null) {
    return frame([
      slot("value", value),
      slot("relation", tokens[auxiliaryIndex]!.text),
      slot("subject", locative.subject),
      slot("qualifier", locative.location)
    ]);
  }
  return frame([
    slot("value", value),
    slot("relation", tokens[auxiliaryIndex]!.text),
    slot("subject", sliceFactFrameTokens(query, tokens, auxiliaryIndex + 1, tokens.length))
  ]);
}

function takeLocativeMeasureComplement(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): Readonly<{ readonly subject: string; readonly location: string }> | null {
  const subject = takeSubject(query, tokens, start);
  const linker = subject === null ? undefined : tokens[subject.nextIndex];
  if (subject === null || linker === undefined ||
      !LOCATIVE_PREPOSITIONS.has(linker.normalized)) {
    return null;
  }
  const location = takeLocationSpan(query, tokens, subject.nextIndex + 1);
  if (location === null || hasContentAfter(tokens, location.nextIndex)) return null;
  return Object.freeze({ subject: subject.text, location: location.text });
}

function takeLocationSpan(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const first = tokens[start];
  if (first === undefined) return null;
  if (isNamedSubjectToken(first)) {
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
  return takeDeterminerSubject(query, tokens, start);
}

const LOCATIVE_PREPOSITIONS: ReadonlySet<string> = new Set(["in", "at", "on"]);

export function isCopularMeasureLayout(
  valueTokens: readonly FactFrameSourceToken[],
  subjectTokens: readonly FactFrameSourceToken[]
): boolean {
  return valueTokens.length === 2 && valueTokens[0]!.normalized === "how" &&
    COPULAR_MEASURE_WORDS.has(valueTokens[1]!.normalized) &&
    subjectTokens.length >= 2 && subjectTokens.length <= MAX_COPULAR_SUBJECT_TOKENS &&
    !subjectTokens.some(({ normalized }) => NEGATIONS.has(normalized) ||
      CLAUSE_BOUNDARIES.has(normalized) || normalized === "and" || normalized === "or");
}

export function parseUnmarkedWhVerbalFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[]
): Readonly<AssociativeFactFrame> | null {
  if (tokens.length < 4 || !isOpenRelationToken(tokens[1] ?? EMPTY_TOKEN) ||
      AUXILIARIES.has(tokens[1]!.normalized)) {
    return null;
  }
  let index = 2;
  if (!isSkippedPronoun(tokens[index] ?? EMPTY_TOKEN)) return null;
  while (index < tokens.length && isSkippedPronoun(tokens[index]!)) index += 1;
  const object = takeDeterminerSubject(query, tokens, index);
  if (object === null) return null;
  const extras = takeAsComplementQualifiers(query, tokens, object.nextIndex);
  if (extras === null) return null;
  return frame([
    slot("value", tokens[0]!.text),
    slot("relation", tokens[1]!.text),
    slot("subject", object.text),
    ...extras
  ]);
}

export function parseHowManyRelativeFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[]
): Readonly<AssociativeFactFrame> | null {
  if (tokens[0]?.normalized !== "how" ||
      !MEASURE_QUANTIFIERS.has(tokens[1]?.normalized ?? "")) {
    return null;
  }
  const relIndex = tokens.findIndex(
    (token, index) => index >= 3 && RELATIVE_MARKERS.has(token.normalized)
  );
  if (relIndex < 3) return null;
  const counted = tokens.slice(2, relIndex);
  if (counted.length === 0 ||
      counted.some((token) => AUXILIARIES.has(token.normalized) ||
        WH_WORDS.has(token.normalized))) {
    return null;
  }
  const subject = takeSubject(query, tokens, relIndex + 1);
  const verb = subject === null ? undefined : tokens[subject.nextIndex];
  if (subject === null || verb === undefined || !isOpenRelationToken(verb) ||
      hasContentAfter(tokens, subject.nextIndex + 1)) {
    return null;
  }
  return frame([
    slot("value", sliceFactFrameTokens(query, tokens, 2, relIndex)),
    slot("subject", subject.text),
    slot("relation", verb.text)
  ]);
}

export function parseOfComplementFrame(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  relationStart: number,
  ofIndex: number,
  value: string
): Readonly<AssociativeFactFrame> | null {
  const relations = selectRelationTokens(tokens, relationStart, ofIndex);
  const subject = takeOfComplementSubject(query, tokens, ofIndex + 1);
  if (relations.length === 0 || subject === null) return null;
  const remainder = takeRelativeRemainderSlots(tokens, subject.nextIndex);
  if (remainder === null) return null;
  return frame([
    slot("value", value),
    ...relations.map((token) => slot("relation", token.text)),
    slot("subject", subject.text),
    ...remainder
  ]);
}

function takeOfComplementSubject(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const possessed = takePossessedNounSubject(query, tokens, start);
  return possessed ?? takeSubject(query, tokens, start);
}

function takePossessedNounSubject(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const first = tokens[start];
  if (first === undefined || !POSSESSIVE_DETERMINERS.has(first.normalized)) return null;
  let end = start + 1;
  while (end < tokens.length && end - start < MAX_SUBJECT_TOKENS &&
      !isOfComplementNounStop(tokens[end]!)) {
    end += 1;
  }
  if (end === start + 1) return null;
  return Object.freeze({
    text: sliceFactFrameTokens(query, tokens, start, end),
    startIndex: start,
    nextIndex: end
  });
}

function takeRelativeRemainderSlots(
  tokens: readonly FactFrameSourceToken[],
  start: number
): readonly Readonly<AssociativeFactSlot>[] | null {
  if (start === tokens.length) return Object.freeze([]);
  let index = start;
  if (RELATIVE_MARKERS.has(tokens[index]!.normalized)) {
    index += 1;
  } else if (!isSkippedPronoun(tokens[index]!)) {
    return null;
  }
  while (index < tokens.length && isSkippedPronoun(tokens[index]!)) index += 1;
  const verb = tokens[index];
  if (verb === undefined || !isOpenRelationToken(verb)) return null;
  index += 1;
  const qualifiers: Readonly<AssociativeFactSlot>[] = [];
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (FUNCTION_WORDS.has(token.normalized) || AUXILIARIES.has(token.normalized)) {
      index += 1;
      continue;
    }
    if (!isNamedSubjectToken(token) && !isOpenRelationToken(token)) return null;
    qualifiers.push(slot("qualifier", token.text));
    index += 1;
  }
  return Object.freeze([slot("relation", verb.text), ...qualifiers]);
}

function takeAsComplementQualifiers(
  query: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): readonly Readonly<AssociativeFactSlot>[] | null {
  if (start === tokens.length) return Object.freeze([]);
  if (tokens[start]?.normalized !== "as") return null;
  const complement = takeDeterminerSubject(query, tokens, start + 1);
  if (complement === null || complement.nextIndex !== tokens.length) return null;
  return Object.freeze([slot("qualifier", complement.text)]);
}

function isOfComplementNounStop(token: FactFrameSourceToken): boolean {
  return isNounPhraseBoundary(token) || RELATIVE_MARKERS.has(token.normalized);
}

function isSkippedPronoun(token: FactFrameSourceToken): boolean {
  return SUBJECT_PRONOUNS.has(token.normalized) || OBJECT_PRONOUNS.has(token.normalized);
}

function hasContentAfter(tokens: readonly FactFrameSourceToken[], start: number): boolean {
  return tokens.slice(start).some((token) => !FUNCTION_WORDS.has(token.normalized));
}
