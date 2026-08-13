import { AUXILIARIES, WH_WORDS } from "./clause-boundaries.js";
import type { FactFrameSourceToken } from "./source-text.js";

// Only shapes whose next token after one simple NP must be the matrix subject.
export function skipLeadingAdjunctSpan(
  tokens: readonly FactFrameSourceToken[],
  isSubjectStart: (index: number) => boolean
): number {
  if (isSubjectStart(0)) return 0;
  return matchInfinitivalBeAdjunct(tokens, 0, isSubjectStart) ??
    matchParticipialAdjunct(tokens, 0, isSubjectStart) ??
    matchPrepositionalAdjunct(tokens, 0, isSubjectStart) ??
    0;
}

function matchInfinitivalBeAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  if (tokens[start]?.normalized !== "to") return null;
  if (tokens[start + 1]?.normalized !== "be") return null;
  const complement = tokens[start + 2];
  const subjectAt = start + 3;
  if (complement === undefined || isSubjectStart(start + 2)) return null;
  if (DETERMINERS.has(complement.normalized) ||
      PREPOSITIONS.has(complement.normalized) ||
      AUXILIARIES.has(complement.normalized)) {
    return null;
  }
  return isSubjectStart(subjectAt) ? subjectAt : null;
}

function matchParticipialAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  const head = tokens[start];
  if (head === undefined || !isPresentParticiple(head)) return null;
  const afterHead = start + 1;
  if (afterHead >= tokens.length || isSubjectStart(afterHead)) return null;
  return matchPrepositionalAdjunct(tokens, afterHead, isSubjectStart);
}

function matchPrepositionalAdjunct(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  if (!PREPOSITIONS.has(tokens[start]?.normalized ?? "")) return null;
  const afterNp = consumeSimpleNp(tokens, start + 1, isSubjectStart);
  return afterNp !== null && isSubjectStart(afterNp) ? afterNp : null;
}

function consumeSimpleNp(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  isSubjectStart: (index: number) => boolean
): number | null {
  const first = tokens[start];
  if (first === undefined || isSubjectStart(start)) return null;
  if (first.normalized === "which") return start + 1;
  if (!DETERMINERS.has(first.normalized)) return null;
  let index = start + 1;
  if (tokens[index] === undefined || isSubjectStart(index)) return null;
  let content = 0;
  while (index < tokens.length) {
    if (isSubjectStart(index)) return content > 0 ? index : null;
    if (isSimpleNpBreaker(tokens[index]!)) return null;
    index += 1;
    content += 1;
  }
  return null;
}

function isSimpleNpBreaker(token: FactFrameSourceToken): boolean {
  return DETERMINERS.has(token.normalized) ||
    PREPOSITIONS.has(token.normalized) ||
    AUXILIARIES.has(token.normalized) ||
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
const DETERMINERS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "my", "your", "his", "her", "its", "our", "their", "some", "any"
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
