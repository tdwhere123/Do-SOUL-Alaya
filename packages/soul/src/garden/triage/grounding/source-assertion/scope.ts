import { hasUnquotedSourceDependentScope, isInsideSourceQuotation } from "@do-soul/alaya-protocol";
import { coordinateSpans, hasDirectQuestionBoundary, sentenceSpans, type AssertionSpan } from "./clause-spans.js";
import { sourceRoleMarkerPrefixLength, stripSourceRoleMarker } from "../source-role/marker.js";
import { hasAssertionPreservingRelativeClauseSuffix } from "./relative-clause.js";

export const SOURCE_ASSERTION_DISCOURSE_PREFIX = /^(?:(?:also)\s*,?\s*)?(?:by the way|anyway|actually|well|speaking of)\s*[,：:—–-]?\s*/iu;

/** Scope-bearing sentences remain whole until fragment independence is proven. */
export function sourceAssertionPreservesScope(source: string, start: number, end: number): boolean {
  if (isInsideSourceQuotation(source, start) || isInsideSourceQuotation(source, end)) return false;
  const sentences = sentenceSpans(source);
  return sentences.every((sentence, index) => {
    if (sentence.end <= start || sentence.start >= end) return true;
    const previous = sentences[index - 1];
    const next = sentences[index + 1];
    const context = stripSourceRoleMarker(source.slice(sentence.start, sentence.end));
    const dependsOnPrevious = previous !== undefined && isDependentContinuation(source, previous, sentence);
    if (startsDependentContinuation(context) && !dependsOnPrevious) return false;
    // A punctuation boundary does not detach a dependent continuation from its matrix clause.
    if (previous !== undefined && dependsOnPrevious &&
        stripSourceRoleMarker(source.slice(previous.start, start)).length > 0) return false;
    if (next !== undefined && isDependentContinuation(source, sentence, next) && end < next.end) return false;
    const retained = stripSourceRoleMarker(source.slice(Math.max(sentence.start, start), Math.min(sentence.end, end)));
    if (sameAssertion(retained, context) || retained === boundedIndirectQuestionPrefix(context)) return true;
    if (hasUnquotedSourceDependentScope(source, sentence.start, sentence.end)) return false;
    if (preservesAtomicContext(context, retained)) return true;
    const clauses = coordinateSpans(source, sentence);
    return clauses.length > 1 && clauses.every((clause, clauseIndex) => {
      const prior = clauses[clauseIndex - 1];
      if (prior !== undefined && /\bor\b/iu.test(source.slice(prior.end, clause.start))) return false;
      return isIndependentSimpleClause(stripSourceRoleMarker(source.slice(clause.start, clause.end)));
    }) && clauses.some((clause) => sameAssertion(retained, stripSourceRoleMarker(source.slice(clause.start, clause.end))));
  });
}

function sameAssertion(left: string, right: string): boolean {
  return left.replace(/[.!?。！？]+$/u, "").trim() === right.replace(/[.!?。！？]+$/u, "").trim();
}

function isDependentContinuation(source: string, previous: AssertionSpan, current: AssertionSpan): boolean {
  if (previous.end > current.start) return false;
  const content = source.slice(current.start, current.end);
  if (sourceRoleMarkerPrefixLength(content) > 0) return false;
  return startsDependentContinuation(content);
}

function startsDependentContinuation(content: string): boolean {
  const lead = content.replace(/^(?:and|but|or)\s+/iu, "");
  const headEnd = lead.search(/\s/u);
  return hasUnquotedSourceDependentScope(lead, 0, headEnd < 0 ? lead.length : headEnd);
}

function preservesAtomicContext(context: string, retained: string): boolean {
  const content = context.replace(SOURCE_ASSERTION_DISCOURSE_PREFIX, "");
  if (sameAssertion(content, retained)) return true;
  if (!content.startsWith(retained)) return false;
  const suffix = content.slice(retained.length);
  return hasAssertionPreservingRelativeClauseSuffix(suffix) ||
    hasAssertionPreservingWorthSuffix(retained, suffix) ||
    (hasDirectQuestionBoundary(content, retained.length) && /\?\s*$/u.test(suffix));
}

export function hasAssertionPreservingWorthSuffix(assertion: string, suffix: string): boolean {
  return /^it\s+(?:took|takes|will\s+take)\s+me\b/iu.test(assertion) &&
    /^\s*,\s*but\s+it\s+(?:was|is|will\s+be)\s+worth\b/iu.test(suffix);
}

/** A bounded affirmative clause; nominal lists and shared adjuncts provide no independence proof. */
function isIndependentSimpleClause(assertion: string): boolean {
  const text = assertion.replace(/[.!?。！？]+$/u, "").trim();
  const subject = /^(?:(?:I|we|you|he|she|it|they)\b|\p{Lu}[\p{L}'’-]*)\s+/u.exec(text);
  if (subject === null) return false;
  const predicate = text.slice(subject[0].length);
  if (/^(?:(?:live|lives|lived)\s+in|(?:move|moves|moved)\s+to)\s+\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,3}$/u.test(predicate)) return true;
  const finite = /^(?:(?:can|could|may|might|must|shall|should|will|would)\s+)?(?:like|likes|liked|enjoy|enjoys|enjoyed|prefer|prefers|preferred|read|reads|use|uses|used|want|wants|wanted|need|needs|needed|have|has|had|avoid|avoids|avoided|start|starts|started|bought|opened|completed)\s+(.+)$/iu.exec(predicate);
  if (finite !== null && /^(?:"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’)$/u.test(finite[1]!)) return true;
  if (finite === null || /\b(?:with|without|except|after|before|from|for|on|in|at|to|by|and|but|or)\b/iu.test(finite[1]!)) return false;
  return /^(?:(?:a|an|the|my|our|your|his|her|their)\s+)?[\p{L}\p{N}'’-]+(?:\s+[\p{L}\p{N}'’-]+){0,5}$/u.test(finite[1]!);
}

/** The closed conversational question does not condition the preceding travel intention. */
export function boundedIndirectQuestionPrefix(content: string): string | null {
  const kinship = "sister|brother|mother|father|aunt|uncle|cousin|niece|nephew|daughter|son|wife|husband|partner|friend";
  const person = "\\p{Lu}[\\p{L}'’-]*";
  const place = "(?:the\\s+)?\\p{Lu}[\\p{L}\\p{N}'’.-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}'’.-]*){0,3}";
  const pattern = new RegExp(
    `^((?:I['’]m|I am)\\s+thinking\\s+of\\s+visiting\\s+(?:my|our)\\s+(?:${kinship})\\s+${person}\\s+in\\s+${place}(?:\\s+soon)?),\\s+and\\s+I\\s+was\\s+wondering\\s+(?:if|whether)\\b[^?,;:—–]*\\?$`,
    "u"
  );
  return pattern.exec(content)?.[1]?.trim() ?? null;
}
