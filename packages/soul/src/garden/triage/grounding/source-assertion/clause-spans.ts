export interface AssertionSpan {
  readonly start: number;
  readonly end: number;
  readonly ambiguous?: boolean;
}

export function sentenceSpans(source: string): readonly AssertionSpan[] {
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

export function coordinateSpan(
  source: string,
  sentence: AssertionSpan,
  offset: number,
  matchedLength: number
): { readonly span: AssertionSpan | null; readonly coordinated: boolean } {
  const spans = coordinateSpans(source, sentence);
  const span = spans.find((candidate) =>
    offset >= candidate.start && offset + matchedLength <= candidate.end
  ) ?? null;
  return { span, coordinated: spans.length > 1 };
}

export function coordinateSpans(
  source: string,
  sentence: AssertionSpan
): readonly AssertionSpan[] {
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
  return spans;
}

export function hasDirectQuestionBoundary(source: string, end: number): boolean {
  return /^\s*,\s*(?:have|did|do|can|could|would|will|are|were|is)\s+you\b/iu.test(
    source.slice(end)
  );
}

export function canExpandAcrossSentenceBoundary(
  source: string,
  previous: AssertionSpan | undefined,
  current: AssertionSpan
): previous is AssertionSpan {
  if (previous === undefined) return false;
  return !/[\r\n]/u.test(source.slice(previous.end, current.start));
}

export function isIncompleteTerminalAbbreviation(token: string): boolean {
  return INCOMPLETE_TERMINAL_ABBREVIATIONS.has(token.toLocaleLowerCase("en-US"));
}

export function trimmedSpan(
  source: string,
  rawStart: number,
  rawEnd: number
): { readonly start: number; readonly end: number } {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/u.test(source[start]!)) start += 1;
  while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
  return { start, end };
}

type DotBoundary = "boundary" | "continuation" | "ambiguous";

const INLINE_BOUNDARY_ABBREVIATIONS = new Set([
  "approx", "capt", "dr", "e.g", "etc", "gov", "i.e", "mr", "mrs", "ms", "prof", "rev", "sen"
]);

const INCOMPLETE_TERMINAL_ABBREVIATIONS = new Set([
  "approx", "capt", "dr", "e.g", "i.e", "mr", "mrs", "ms", "prof", "rev", "sen"
]);

function appendSentenceSpan(
  spans: AssertionSpan[],
  source: string,
  start: number,
  end: number,
  ambiguous: boolean
): void {
  if (source.slice(start, end).trim().length === 0) return;
  spans.push({ ...trimmedSpan(source, start, end), ...(ambiguous ? { ambiguous: true } : {}) });
}

function classifyDotBoundary(source: string, index: number): DotBoundary {
  const before = source[index - 1] ?? "";
  const after = source[index + 1] ?? "";
  if (/\d/u.test(before) && /\d/u.test(after)) return "continuation";
  if (/\p{L}/u.test(before) && /[\p{L}\p{N}]/u.test(after)) {
    const token = tokenBefore(source, index);
    if (/^\p{Lu}$/u.test(token) && /\p{Lu}/u.test(after)) return "continuation";
    return /\p{Ll}/u.test(after) ? "ambiguous" : "boundary";
  }
  const next = nextNonWhitespace(source, index + 1);
  if (next >= source.length) return "boundary";
  const token = tokenBefore(source, index);
  if (isInitialism(token)) return "ambiguous";
  if (token.includes(".") && !/^\d+(?:\.\d+)+$/u.test(token)) return "ambiguous";
  if (/^\p{Lu}$/u.test(token) || isInlineBoundaryAbbreviation(token)) return "ambiguous";
  if (/\p{Ll}/u.test(source[next] ?? "")) return "ambiguous";
  return "boundary";
}

function isInitialism(token: string): boolean {
  return /^(?:\p{Lu}\.)+\p{Lu}$/u.test(token);
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

function isInlineBoundaryAbbreviation(token: string): boolean {
  return INLINE_BOUNDARY_ABBREVIATIONS.has(token.toLocaleLowerCase("en-US"));
}
