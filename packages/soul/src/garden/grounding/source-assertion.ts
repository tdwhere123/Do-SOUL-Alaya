import { PREFERENCE_FACT_MAX_CHARS } from "@do-soul/alaya-protocol";
import {
  canExpandAcrossSentenceBoundary,
  coordinateSpan,
  hasDirectQuestionBoundary,
  isIncompleteTerminalAbbreviation,
  sentenceSpans,
  type AssertionSpan
} from "./source-assertion/clause-spans.js";
import {
  hasUnresolvedReference,
  isLocallyClosedAtomicAssertion,
  isBoundedTemplateSlotAssertion,
  startsWithChineseThirdPersonSubject
} from "./source-assertion/reference-closure.js";
import {
  hasAssertionPreservingRelativeClauseSuffix,
  hasRelativeClauseSuffix
} from "./source-assertion/relative-clause.js";
import { stripSourceRoleMarker } from "./source-role/marker.js";

export type SourceAssertionResolution =
  | { readonly status: "grounded"; readonly assertion: string }
  | { readonly status: "rejected"; readonly reason: SourceAssertionRejectionReason };

export type SourceAssertionRejectionReason =
  | "matched_text_absent"
  | "matched_text_ambiguous"
  | "source_assertion_incomplete"
  | "source_assertion_not_self_contained"
  | "source_assertion_too_long";

export const SOURCE_ASSERTION_MAX_CHARS = 500;
export const PREFERENCE_SOURCE_ASSERTION_MAX_CHARS = PREFERENCE_FACT_MAX_CHARS;

export function buildSourceVerificationText(
  sourceText: string,
  assertion: string,
  maxChars = 2_048
): string {
  if (sourceText.length <= maxChars) return sourceText;
  const assertionStart = sourceText.indexOf(assertion);
  if (assertionStart < 0 || assertion.length > maxChars) return sourceText.slice(0, maxChars);
  const contextBudget = maxChars - assertion.length;
  const start = Math.max(0, assertionStart - Math.floor(contextBudget / 2));
  const boundedStart = Math.min(start, sourceText.length - maxChars);
  return sourceText.slice(boundedStart, boundedStart + maxChars);
}

export function resolveSourceAssertion(
  sourceText: string,
  matchedText: string,
  maxChars = SOURCE_ASSERTION_MAX_CHARS
): SourceAssertionResolution {
  const source = sourceText.trim();
  const matched = matchedText.trim();
  if (source.length === 0 || matched.length === 0) {
    return { status: "rejected", reason: "matched_text_absent" };
  }
  const boundedPrefix = resolveBoundedVerbatimPrefix(source, matched, maxChars);
  if (boundedPrefix !== null) return boundedPrefix;
  const spans = sentenceSpans(source);
  const resolutions: SourceAssertionResolution[] = [];
  let offset = source.indexOf(matched);
  while (offset >= 0) {
    const span = enclosingSentenceSpan(spans, offset, matched.length);
    if (span !== null) {
      resolutions.push(resolveAssertionAt(
        source,
        matched,
        offset,
        span.sentence,
        spans[span.startIndex - 1],
        maxChars
      ));
    }
    offset = source.indexOf(matched, offset + 1);
  }
  if (resolutions.length === 0) return { status: "rejected", reason: "matched_text_absent" };
  if (resolutions.length > 1) return { status: "rejected", reason: "matched_text_ambiguous" };
  return resolutions[0]!;
}

export function resolveAtomicSourceAssertion(
  assertionText: string,
  maxChars = SOURCE_ASSERTION_MAX_CHARS
): SourceAssertionResolution {
  const assertion = stripSourceRoleLabel(assertionText);
  if (assertion.length === 0) return { status: "rejected", reason: "matched_text_absent" };
  if (assertion.length > maxChars) {
    return { status: "rejected", reason: "source_assertion_too_long" };
  }
  if (!isLocallyClosedAtomicAssertion(assertion)) {
    return { status: "rejected", reason: "source_assertion_not_self_contained" };
  }
  if (isVacuousFirstPersonStub(assertion) || !hasCompleteClause(assertion, false)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  return { status: "grounded", assertion };
}

function enclosingSentenceSpan(
  spans: readonly AssertionSpan[],
  offset: number,
  matchedLength: number
): { readonly sentence: AssertionSpan; readonly startIndex: number } | null {
  const endOffset = offset + matchedLength;
  const startIndex = spans.findIndex((candidate) =>
    offset >= candidate.start && offset < candidate.end
  );
  const endIndex = spans.findIndex((candidate) =>
    endOffset > candidate.start && endOffset <= candidate.end
  );
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null;
  const first = spans[startIndex]!;
  const last = spans[endIndex]!;
  if (startIndex === endIndex) return { sentence: first, startIndex };
  // Verbatim match may span sentence boundaries; evaluate the enclosed range.
  return { sentence: { start: first.start, end: last.end }, startIndex };
}

function resolveBoundedVerbatimPrefix(
  source: string,
  matched: string,
  maxChars: number
): SourceAssertionResolution | null {
  const offset = source.indexOf(matched);
  if (offset < 0) return null;
  const assertion = stripSourceRoleLabel(matched);
  if (assertion.length > maxChars) {
    return { status: "rejected", reason: "source_assertion_too_long" };
  }
  const suffix = source.slice(offset + matched.length);
  const worthSuffix = hasWorthItSuffix(assertion, suffix);
  const relativeSuffix = hasRelativeClauseSuffix(suffix);
  if (!(relativeSuffix || worthSuffix) || !hasFirstPersonAssertionAnchor(assertion)) return null;
  if (source.indexOf(matched, offset + 1) >= 0) {
    return { status: "rejected", reason: "matched_text_ambiguous" };
  }
  if (!hasMatchedTextStartBoundary(source, offset)) {
    return { status: "rejected", reason: "matched_text_absent" };
  }
  if (relativeSuffix && !hasAssertionPreservingRelativeClauseSuffix(suffix)) {
    return { status: "rejected", reason: "source_assertion_not_self_contained" };
  }
  if (isVacuousFirstPersonStub(assertion)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  if (!hasUnresolvedReference(assertion) && hasCompleteClause(assertion, false)) {
    return { status: "grounded", assertion };
  }
  return null;
}

function hasMatchedTextStartBoundary(source: string, offset: number): boolean {
  return !isWordCharacter(source[offset - 1]);
}

function hasWorthItSuffix(assertion: string, suffix: string): boolean {
  return /^it\s+(?:took|takes|will\s+take)\s+me\b/iu.test(assertion) &&
    /^\s*,\s*but\s+it\s+(?:was|is|will\s+be)\s+worth\b/iu.test(suffix);
}

function hasFirstPersonAssertionAnchor(assertion: string): boolean {
  return /^(?:i\b|i['’](?:m|d|ll|ve)\b)/iu.test(assertion) ||
    /^it\s+(?:took|takes|will\s+take)\s+me\b/iu.test(assertion);
}

function isVacuousFirstPersonStub(assertion: string): boolean {
  const value = assertion.trim()
    .replace(/^i[’']m\b/iu, "I am")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
  return /^(?:i|i['’](?:m|d|ll|ve))\s*$/iu.test(value) ||
    /^(?:i|i['’](?:m|d|ll|ve))\s+(?:am|think|know|mean|see|guess|feel|agree|did|never|want|need|hope|believe|was|can|should|will|do|say)\s*$/iu.test(value) ||
    /^(?:i|i['’](?:m|d|ll|ve))\s+(?:think|guess|believe|hope|am|was)\s+(?:so|sure)\s*$/iu.test(value) ||
    /^i['’]d\s+say\s*$/iu.test(value);
}

export function filterSourceAssertionEntities(
  entities: readonly string[],
  assertion: string
): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    const normalized = normalizeSourceEntity(entity, assertion);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return Object.freeze(output);
}

function normalizeSourceEntity(entity: string, assertion: string): string | null {
  const normalized = entity.trim().toLowerCase();
  if (isFirstPersonEntity(normalized)) {
    return hasSingularFirstPerson(assertion) ? "operator" : null;
  }
  if (normalized === "operator" && hasSingularFirstPerson(assertion)) return "operator";
  return containsWholeEntity(assertion, normalized) ? normalized : null;
}

function isFirstPersonEntity(entity: string): boolean {
  return /^(?:i|me|my|mine|myself|我)$/iu.test(entity);
}

function hasSingularFirstPerson(assertion: string): boolean {
  return /\b(?:i|me|my|mine|myself)\b/iu.test(assertion) ||
    /(?:^|[^\p{L}\p{N}])我(?!们|司)/u.test(assertion);
}

function containsWholeEntity(sourceText: string, entity: string): boolean {
  const source = sourceText.toLowerCase();
  const needle = entity.toLowerCase();
  let start = source.indexOf(needle);
  while (start >= 0) {
    const before = source[start - 1];
    const after = source[start + needle.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    start = source.indexOf(needle, start + 1);
  }
  return false;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function resolveAssertionAt(
  source: string,
  matched: string,
  offset: number,
  sentence: AssertionSpan,
  previousSentence: AssertionSpan | undefined,
  maxChars: number
): SourceAssertionResolution {
  if (hasCrossSentenceChineseReference(source, sentence, previousSentence)) {
    return { status: "rejected", reason: "source_assertion_not_self_contained" };
  }
  const coordinate = coordinateSpan(source, sentence, offset, matched.length);
  const candidates = assertionCandidates(
    source,
    offset,
    matched.length,
    sentence,
    previousSentence,
    coordinate
  );
  const exactHasDanglingTerminal = hasDanglingExactTerminal(source, candidates[0]!);
  const matchedDisambiguatesInitialism = /(?:\p{Lu}\.){2,}\s+\p{Ll}/u.test(matched);
  if (exactHasDanglingTerminal && candidates[0]!.span.end === sentence.end) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  let rejectionReason: SourceAssertionRejectionReason = "source_assertion_incomplete";
  for (const [index, candidate] of candidates.entries()) {
    if (index === 0 && exactHasDanglingTerminal) continue;
    const resolution = evaluateAssertionCandidate(source, candidate, maxChars);
    if (resolution.status === "grounded") return resolution;
    rejectionReason = strongerRejectionReason(rejectionReason, resolution.reason);
    if (index === 0 && sentence.ambiguous === true && !matchedDisambiguatesInitialism) break;
  }
  return { status: "rejected", reason: rejectionReason };
}

function hasCrossSentenceChineseReference(
  source: string,
  sentence: AssertionSpan,
  previousSentence: AssertionSpan | undefined
): boolean {
  if (previousSentence === undefined) return false;
  return startsWithChineseThirdPersonSubject(
    stripSourceRoleLabel(source.slice(sentence.start, sentence.end))
  );
}

interface AssertionCandidate {
  readonly span: AssertionSpan;
  readonly coordinated: boolean;
  readonly exact: boolean;
}

function assertionCandidates(
  source: string,
  offset: number,
  matchedLength: number,
  sentence: AssertionSpan,
  previousSentence: AssertionSpan | undefined,
  coordinate: ReturnType<typeof coordinateSpan>
): readonly AssertionCandidate[] {
  const candidates: AssertionCandidate[] = [
    {
      span: { start: offset, end: offset + matchedLength },
      coordinated: true,
      exact: true
    }
  ];
  if (coordinate.span !== null &&
      (coordinate.span.start !== sentence.start || coordinate.span.end !== sentence.end)) {
    candidates.push({
      span: coordinate.span,
      coordinated: coordinate.coordinated,
      exact: false
    });
  }
  candidates.push({ span: sentence, coordinated: false, exact: false });
  if (canExpandAcrossSentenceBoundary(source, previousSentence, sentence)) {
    candidates.push({
      span: { start: previousSentence.start, end: sentence.end },
      coordinated: false,
      exact: false
    });
  }
  return candidates;
}

function evaluateAssertionCandidate(
  source: string,
  candidate: AssertionCandidate,
  maxChars: number
): SourceAssertionResolution {
  const assertion = stripSourceRoleLabel(source.slice(candidate.span.start, candidate.span.end));
  if (candidate.exact && !/[.!?。！？]$/u.test(assertion) &&
      !hasDirectQuestionBoundary(source, candidate.span.end)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  if (assertion.length > maxChars) {
    return { status: "rejected", reason: "source_assertion_too_long" };
  }
  if (isVacuousFirstPersonStub(assertion)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  if (hasUnresolvedReference(assertion)) {
    return { status: "rejected", reason: "source_assertion_not_self_contained" };
  }
  if (!hasCompleteClause(assertion, candidate.coordinated)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  return { status: "grounded", assertion };
}

function hasDanglingExactTerminal(
  source: string,
  exact: AssertionCandidate
): boolean {
  const assertion = stripSourceRoleLabel(source.slice(exact.span.start, exact.span.end));
  const token = /([\p{L}.]+)\.$/u.exec(assertion)?.[1];
  return token !== undefined && isIncompleteTerminalAbbreviation(token);
}

function stripSourceRoleLabel(assertion: string): string {
  const trimmed = assertion.trim();
  const roleStripped = stripSourceRoleMarker(trimmed);
  return roleStripped === trimmed
    ? trimmed.replace(/^[\t\p{Zs}]*团队[\t\p{Zs}]*(?::|：)[\t\p{Zs}]*/u, "").trim()
    : roleStripped;
}

function strongerRejectionReason(
  current: SourceAssertionRejectionReason,
  candidate: SourceAssertionRejectionReason
): SourceAssertionRejectionReason {
  const priority: Readonly<Record<SourceAssertionRejectionReason, number>> = {
    matched_text_absent: 0,
    matched_text_ambiguous: 0,
    source_assertion_incomplete: 1,
    source_assertion_not_self_contained: 2,
    source_assertion_too_long: 3
  };
  return priority[candidate] > priority[current] ? candidate : current;
}

function hasCompleteClause(assertion: string, coordinated: boolean): boolean {
  if (isBoundedTemplateSlotAssertion(assertion)) return true;
  const value = assertion.trim().replace(/[.!?。！？]+$/u, "").trim();
  const dummySubject = /^it\s+(?:took|takes|will\s+take)\s+me\b\s*(.*)$/iu.exec(value);
  if (dummySubject !== null) return hasContent(dummySubject[1]);
  const englishSubject = /^(?:i|we|you)\b\s*(.*)$/iu.exec(value);
  if (englishSubject !== null) return hasContent(englishSubject[1]);
  const chineseSubject = /^(?:我(?:们)?|你(?:们)?|您|他(?:们)?|她(?:们)?|它(?:们)?|用户|助手|团队|项目|系统)(.*)$/u.exec(value);
  if (chineseSubject !== null) return hasContent(chineseSubject[1]);
  const namedSubject = /^\p{Lu}[\p{L}\p{N}'’-]*\s+(.*)$/u.exec(value);
  if (namedSubject !== null) return hasContent(namedSubject[1]);
  return !coordinated && hasCompleteChineseClause(value);
}

function hasCompleteChineseClause(value: string): boolean {
  if (!/^\p{Script=Han}/u.test(value)) return false;
  const contentLength = value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return contentLength >= 4;
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
