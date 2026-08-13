import type { FactFrameSourceToken } from "./source-text.js";

// Position 0 is not the subject test: a fronted PP or participial disjunct
// displaces the matrix subject without deleting it.
export function skipLeadingAdjunctSpan(
  tokens: readonly FactFrameSourceToken[],
  isSubjectStart: (index: number) => boolean
): number {
  let index = 0;
  let skipped = 0;
  while (index < tokens.length && skipped < MAX_LEADING_ADJUNCTS) {
    if (isSubjectStart(index)) return index;
    const next = consumeOneAdjunct(tokens, index, isSubjectStart);
    if (next === null) return index;
    index = next;
    skipped += 1;
  }
  return index;
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
  // Unspaced CJK is one token; English P/-ing tests must not look inside it.
  if (CJK_SCRIPT.test(token.text) && isSubjectStart(start + 1)) {
    return start + 1;
  }
  return null;
}

function consumeParticipialAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  const afterHead = start + 1;
  if (afterHead >= tokens.length) return null;
  if (isSubjectStart(afterHead)) return afterHead;
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
  const limit = Math.min(tokens.length, start + MAX_PREPOSITIONAL_SPAN_TOKENS);
  while (index < limit && !isSubjectStart(index)) {
    index += 1;
  }
  if (index === limit && limit < tokens.length && !isSubjectStart(index)) {
    return null;
  }
  return index;
}

function isPresentParticiple(token: FactFrameSourceToken): boolean {
  return token.normalized.endsWith("ing") &&
    !PREPOSITIONS.has(token.normalized) &&
    !INDEFINITE_ING_PRONOUNS.has(token.normalized);
}

const MAX_LEADING_ADJUNCTS = 3;
const MAX_PREPOSITIONAL_SPAN_TOKENS = 12;
const CJK_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const INDEFINITE_ING_PRONOUNS: ReadonlySet<string> = new Set([
  "something", "anything", "nothing", "everything"
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
