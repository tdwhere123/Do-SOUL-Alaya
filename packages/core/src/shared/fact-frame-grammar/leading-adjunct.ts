import {
  AUXILIARIES,
  CLAUSE_BOUNDARIES,
  WH_WORDS
} from "./clause-boundaries.js";
import type { FactFrameSourceToken } from "./source-text.js";

// Position 0 is not the subject test: a fronted PP or participial disjunct
// displaces the matrix subject without deleting it.
export function skipLeadingAdjunctSpan(
  tokens: readonly FactFrameSourceToken[],
  isSubjectStart: (index: number) => boolean
): number {
  let index = 0;
  while (index < tokens.length) {
    if (isSubjectStart(index)) return index;
    const next = consumeOneAdjunct(tokens, index, isSubjectStart);
    if (next === null) return 0;
    index = next;
  }
  return 0;
}

function consumeOneAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  const token = tokens[start];
  if (token === undefined) return null;
  if (PREPOSITIONS.has(token.normalized)) {
    return consumePrepositionalAdjunct(tokens, start, isSubjectStart);
  }
  if (isPresentParticiple(token)) {
    return consumeParticipialAdjunct(tokens, start, isSubjectStart);
  }
  return null;
}

function consumeParticipialAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  const afterHead = start + 1;
  if (afterHead >= tokens.length || isSubjectStart(afterHead)) return null;
  const next = tokens[afterHead];
  if (next !== undefined && PREPOSITIONS.has(next.normalized)) {
    return consumePrepositionalAdjunct(tokens, afterHead, isSubjectStart);
  }
  return null;
}

function consumePrepositionalAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  let index = start + 1;
  if (index >= tokens.length || isSubjectStart(index)) return null;
  let seenNp = false;
  while (index < tokens.length) {
    if (isSubjectStart(index)) return index;
    if (seenNp) {
      if (spanCut(tokens, index, isSubjectStart) === "reject") return null;
    } else if (opensFiniteClause(tokens, index, isSubjectStart)) {
      return null;
    }
    seenNp = true;
    index += 1;
  }
  return null;
}

function spanCut(
  tokens: readonly FactFrameSourceToken[],
  index: number,
  isSubjectStart: (index: number) => boolean
): "reject" | "continue" {
  const token = tokens[index];
  if (token === undefined) return "reject";
  if (isFiniteOrInterrogativeHead(token)) return "reject";
  if (CLAUSE_BOUNDARIES.has(token.normalized) && isSubjectStart(index + 1)) {
    return "reject";
  }
  return "continue";
}

function opensFiniteClause(
  tokens: readonly FactFrameSourceToken[],
  index: number,
  isSubjectStart: (index: number) => boolean
): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (isFiniteOrInterrogativeHead(token)) return true;
  return CLAUSE_BOUNDARIES.has(token.normalized) && isSubjectStart(index + 1);
}

function isFiniteOrInterrogativeHead(token: FactFrameSourceToken): boolean {
  return AUXILIARIES.has(token.normalized) ||
    WH_WORDS.has(token.normalized) ||
    /n't$/u.test(token.normalized);
}

function isPresentParticiple(token: FactFrameSourceToken): boolean {
  return token.normalized.endsWith("ing") &&
    !PREPOSITIONS.has(token.normalized) &&
    !ING_SPELLING_COLLISIONS.has(token.normalized);
}

const ING_SPELLING_COLLISIONS: ReadonlySet<string> = new Set([
  "something", "anything", "nothing", "everything", "thing"
]);
const PREPOSITIONS: ReadonlySet<string> = new Set([
  "about", "above", "across", "after", "against", "along", "amid", "among",
  "around", "as", "at", "before", "behind", "below", "beneath", "beside",
  "besides", "between", "beyond", "by", "despite", "down", "during",
  "except", "for", "from", "in", "inside", "into", "like", "near", "of",
  "off", "on", "onto", "out", "outside", "over", "past", "per", "since",
  "than", "through", "throughout", "to", "toward", "towards", "under",
  "underneath", "until", "unto", "up", "upon", "versus", "via", "with",
  "within", "without"
]);
