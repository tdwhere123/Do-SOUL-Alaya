import { trimmedSpan, type AssertionSpan } from "./clause-spans.js";
import { isLocallyClosedAtomicAssertion } from "./reference-closure.js";
import { hasAssertionPreservingRelativeClauseSuffix } from "./relative-clause.js";
import { sourceRoleMarkerPrefixLength } from "../source-role/marker.js";

const DISCOURSE_PREFIX = /^(?:(?:also)\s*,?\s*)?(?:by the way|anyway|actually|well|speaking of)\s*[,：:—–-]?\s*/iu;
const RELATIVE_CLAUSE = /,\s*(?:which|who)\b/iu;
const CONVERSATIONAL_TAIL = /,\s*have\s+you\s+heard\s+of\s+(?:it|that|them)\?\s*$/iu;
const DECLARATIVE_TAIL_SUBJECT = /^(?:the|a|an|this|that|these|those|my|our|your|his|her|their)\s+\p{L}/iu;
const DECLARATIVE_TAIL_PREDICATE = /\b(?:is|are|was|were)\b/iu;
const QUESTION_CUE = /\b(?:whether|if|what|when|where|why|who|whom|whose|which|how|do|does|did|can|could|would|will|should|may|might|must|shall|any|at\s+all|or\s+not)\b/iu;

export function atomicAssertionSpans(
  sourceText: string,
  sentence: AssertionSpan
): readonly AssertionSpan[] {
  const text = sourceText.slice(sentence.start, sentence.end);
  const boundary = leadingContentBoundary(text);
  const contentStart = sentence.start + boundary.contentOffset;
  const output: AssertionSpan[] = [];
  const directQuestion = /[?？]\s*$/u.test(text);
  if (directQuestion) {
    appendTailAssertion(output, sourceText, contentStart, sentence);
    return output;
  }
  if (boundary.hasDiscoursePrefix) {
    appendAtomicAssertion(output, sourceText, contentStart, sentence.end);
  }
  appendRelativeClauseAssertion(output, sourceText, contentStart, sentence.end);
  return output;
}

function leadingContentBoundary(text: string): {
  readonly contentOffset: number;
  readonly hasDiscoursePrefix: boolean;
} {
  const roleLength = sourceRoleMarkerPrefixLength(text);
  const discourse = DISCOURSE_PREFIX.exec(text.slice(roleLength))?.[0] ?? "";
  return {
    contentOffset: roleLength + discourse.length,
    hasDiscoursePrefix: discourse.length > 0
  };
}

function appendTailAssertion(
  output: AssertionSpan[],
  sourceText: string,
  start: number,
  sentence: AssertionSpan
): void {
  const text = sourceText.slice(sentence.start, sentence.end);
  const tail = CONVERSATIONAL_TAIL.exec(text);
  if (tail === null) return;
  const end = sentence.start + tail.index;
  const candidate = sourceText.slice(start, end).trim();
  if (candidate.length === 0 || !DECLARATIVE_TAIL_SUBJECT.test(candidate) ||
      !DECLARATIVE_TAIL_PREDICATE.test(candidate) || QUESTION_CUE.test(candidate)) return;
  appendAtomicAssertion(output, sourceText, start, end);
}

function appendRelativeClauseAssertion(
  output: AssertionSpan[],
  sourceText: string,
  start: number,
  end: number
): void {
  const relative = RELATIVE_CLAUSE.exec(sourceText.slice(start, end));
  if (relative === null || relative.index === 0) return;
  if (!hasAssertionPreservingRelativeClauseSuffix(sourceText.slice(start + relative.index, end))) {
    return;
  }
  appendAtomicAssertion(output, sourceText, start, start + relative.index);
}

function appendAtomicAssertion(
  output: AssertionSpan[],
  sourceText: string,
  start: number,
  end: number
): void {
  const span = trimmedSpan(sourceText, start, end);
  if (span.start === span.end || !isLocallyClosedAtomicAssertion(sourceText.slice(span.start, span.end))) {
    return;
  }
  output.push(span);
}
