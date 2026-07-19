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
  matchedText: string
): SourceAssertionResolution {
  const source = sourceText.trim();
  const matched = matchedText.trim();
  if (source.length === 0 || matched.length === 0) {
    return { status: "rejected", reason: "matched_text_absent" };
  }
  const spans = sentenceSpans(source);
  const resolutions: SourceAssertionResolution[] = [];
  let offset = source.indexOf(matched);
  while (offset >= 0) {
    const span = spans.find((candidate) =>
      offset >= candidate.start && offset + matched.length <= candidate.end
    );
    if (span !== undefined) resolutions.push(resolveAssertionAt(source, matched, offset, span));
    offset = source.indexOf(matched, offset + 1);
  }
  if (resolutions.length === 0) return { status: "rejected", reason: "matched_text_absent" };
  if (resolutions.length > 1) return { status: "rejected", reason: "matched_text_ambiguous" };
  return resolutions[0]!;
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

interface AssertionSpan {
  readonly start: number;
  readonly end: number;
  readonly ambiguous?: boolean;
}

function sentenceSpans(source: string): readonly AssertionSpan[] {
  const spans: AssertionSpan[] = [];
  let start = 0;
  let ambiguous = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\n" || character === "\r") {
      appendSentenceSpan(spans, source, start, index, ambiguous);
      start = index + 1;
      ambiguous = false;
      continue;
    }
    if (!/[.!?。！？]/u.test(character)) continue;
    if (character === ".") {
      const dot = classifyDotBoundary(source, index);
      if (dot !== "boundary") {
        ambiguous ||= dot === "ambiguous";
        continue;
      }
    }
    appendSentenceSpan(spans, source, start, index + 1, ambiguous);
    start = index + 1;
    ambiguous = false;
  }
  appendSentenceSpan(spans, source, start, source.length, ambiguous);
  return spans;
}

function appendSentenceSpan(
  spans: AssertionSpan[], source: string, start: number, end: number, ambiguous: boolean
): void {
  if (source.slice(start, end).trim().length === 0) return;
  spans.push({ ...trimmedSpan(source, start, end), ...(ambiguous ? { ambiguous: true } : {}) });
}

type DotBoundary = "boundary" | "continuation" | "ambiguous";

const INLINE_BOUNDARY_ABBREVIATIONS = new Set([
  "approx", "capt", "dr", "e.g", "etc", "gov", "i.e", "mr", "mrs", "ms", "prof", "rev", "sen"
]);

const INCOMPLETE_TERMINAL_ABBREVIATIONS = new Set([
  "approx", "capt", "dr", "e.g", "i.e", "mr", "mrs", "ms", "prof", "rev", "sen"
]);

function classifyDotBoundary(source: string, index: number): DotBoundary {
  const before = source[index - 1] ?? "";
  const after = source[index + 1] ?? "";
  if (/\d/u.test(before) && /\d/u.test(after)) return "continuation";
  if (/\p{L}/u.test(before) && /[\p{L}\p{N}]/u.test(after)) {
    const token = tokenBefore(source, index);
    return /\p{Ll}/u.test(after) || /^\p{Lu}$/u.test(token) ? "ambiguous" : "boundary";
  }
  const next = nextNonWhitespace(source, index + 1);
  if (next >= source.length) return "boundary";
  const token = tokenBefore(source, index);
  if (token.includes(".") && !/^\d+(?:\.\d+)+$/u.test(token)) return "ambiguous";
  if (/^\p{Lu}$/u.test(token) || isInlineBoundaryAbbreviation(token)) return "ambiguous";
  if (/\p{Ll}/u.test(source[next] ?? "")) return "ambiguous";
  return "boundary";
}

function tokenBefore(source: string, index: number): string {
  let start = index;
  while (start > 0 && /[\p{L}\p{N}.]/u.test(source[start - 1]!)) start -= 1;
  return source.slice(start, index);
}

function nextNonWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index]!)) index += 1;
  return index;
}

function resolveAssertionAt(
  source: string,
  matched: string,
  offset: number,
  sentence: AssertionSpan
): SourceAssertionResolution {
  const coordinate = coordinateSpan(source, sentence, offset, matched.length);
  const candidates = assertionCandidates(offset, matched.length, sentence, coordinate);
  const exactHasDanglingTerminal = hasDanglingExactTerminal(source, candidates[0]!);
  if (exactHasDanglingTerminal && candidates[0]!.span.end === sentence.end) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  let rejectionReason: SourceAssertionRejectionReason = "source_assertion_incomplete";
  for (const [index, candidate] of candidates.entries()) {
    if (index === 0 && exactHasDanglingTerminal) continue;
    const resolution = evaluateAssertionCandidate(source, candidate);
    if (resolution.status === "grounded") return resolution;
    rejectionReason = strongerRejectionReason(rejectionReason, resolution.reason);
    if (index === 0 && sentence.ambiguous === true) break;
  }
  return { status: "rejected", reason: rejectionReason };
}

interface AssertionCandidate {
  readonly span: AssertionSpan;
  readonly coordinated: boolean;
  readonly exact: boolean;
}

function assertionCandidates(
  offset: number,
  matchedLength: number,
  sentence: AssertionSpan,
  coordinate: ReturnType<typeof coordinateSpan>
): readonly AssertionCandidate[] {
  const candidates: AssertionCandidate[] = [
    {
      span: { start: offset, end: offset + matchedLength },
      coordinated: true,
      exact: true
    }
  ];
  if (coordinate.span !== null) {
    candidates.push({
      span: coordinate.span,
      coordinated: coordinate.coordinated,
      exact: false
    });
  }
  candidates.push({ span: sentence, coordinated: false, exact: false });
  return candidates;
}

function evaluateAssertionCandidate(
  source: string,
  candidate: AssertionCandidate
): SourceAssertionResolution {
  const assertion = stripSourceRoleLabel(source.slice(candidate.span.start, candidate.span.end));
  if (candidate.exact && !/[.!?。！？]$/u.test(assertion)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  if (assertion.length > SOURCE_ASSERTION_MAX_CHARS) {
    return { status: "rejected", reason: "source_assertion_too_long" };
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

function isInlineBoundaryAbbreviation(token: string): boolean {
  return INLINE_BOUNDARY_ABBREVIATIONS.has(token.toLocaleLowerCase("en-US"));
}

function isIncompleteTerminalAbbreviation(token: string): boolean {
  return INCOMPLETE_TERMINAL_ABBREVIATIONS.has(token.toLocaleLowerCase("en-US"));
}

function stripSourceRoleLabel(assertion: string): string {
  return assertion.trim().replace(/^(?:User|Assistant)\s*:\s*/iu, "").trim();
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

function coordinateSpan(
  source: string,
  sentence: AssertionSpan,
  offset: number,
  matchedLength: number
): { readonly span: AssertionSpan | null; readonly coordinated: boolean } {
  const text = source.slice(sentence.start, sentence.end);
  const separator = /[;；]\s*|,\s*(?:and|but|or)\s+|\s+(?:and|but|or)\s+|，\s*(?:而且|但是|但|并且|并|然后)\s*/giu;
  const spans: AssertionSpan[] = [];
  let start = sentence.start;
  for (const match of text.matchAll(separator)) {
    const end = sentence.start + match.index;
    if (source.slice(start, end).trim().length > 0) spans.push(trimmedSpan(source, start, end));
    start = end + match[0].length;
  }
  if (source.slice(start, sentence.end).trim().length > 0) {
    spans.push(trimmedSpan(source, start, sentence.end));
  }
  const span = spans.find((candidate) =>
    offset >= candidate.start && offset + matchedLength <= candidate.end
  ) ?? null;
  return { span, coordinated: spans.length > 1 };
}

function hasCompleteClause(assertion: string, coordinated: boolean): boolean {
  const value = assertion.trim().replace(/[.!?。！？]+$/u, "").trim();
  const englishSubject = /^(?:i|we|you)\b\s*(.*)$/iu.exec(value);
  if (englishSubject !== null) return hasContent(englishSubject[1]);
  const chineseSubject = /^(?:我(?:们)?|你(?:们)?|您|他(?:们)?|她(?:们)?|它(?:们)?|用户|团队|项目|系统)(.*)$/u.exec(value);
  if (chineseSubject !== null) return hasContent(chineseSubject[1]);
  const namedSubject = /^\p{Lu}[\p{L}\p{N}'’-]*\s+(.*)$/u.exec(value);
  if (namedSubject !== null) return hasContent(namedSubject[1]);
  return !coordinated && /^[\p{Script=Han}]{4,}$/u.test(value);
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function hasUnresolvedReference(assertion: string): boolean {
  return /\b(?:he|she|it|they|him|her|them|his|hers|their|there|here|this|that|these|those|aforementioned|such)\b/iu.test(assertion) ||
    /\bthe\s+(?:former|latter|same|above|below)\b/iu.test(assertion) ||
    /^(?:他|她|它|他们|她们|它们)/u.test(assertion) ||
    /(?:这里|那里|这个|那个|这些|那些|前者|后者|上述|下述|同上|同下|该(?:项|对象|方案|内容|规则|设置|问题)|此(?:项|对象|方案|内容|规则|设置|问题))/u.test(assertion);
}

function trimmedSpan(source: string, rawStart: number, rawEnd: number): { start: number; end: number } {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(source[start]!)) start += 1;
  while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
  return { start, end };
}
