export interface RecallVerifiedUserAssertionContext {
  readonly schema_version: 1;
  readonly source_role: "user";
  readonly evidence_ref: string;
  readonly assertion_text: string;
  readonly user_context: string;
}

interface RoleSpan {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface SentenceSpan {
  readonly start: number;
  readonly end: number;
}

export function projectVerifiedUserAssertionContext(params: Readonly<{
  readonly evidenceRef: string;
  readonly entryContent: string;
  readonly gist: string;
}>): Readonly<RecallVerifiedUserAssertionContext> | null {
  const assertion = params.entryContent.trim();
  const evidenceRef = params.evidenceRef.trim();
  if (assertion.length === 0 || evidenceRef.length === 0) return null;
  const spans = parseRoleSpans(params.gist);
  if (spans === null) return null;
  const anchored = findUniqueUserAssertion(spans, assertion);
  if (anchored === null) return null;
  const userContext = buildSentenceWindow(anchored.text, anchored.index, assertion.length);
  if (userContext.length === 0) return null;
  return Object.freeze({
    schema_version: 1,
    source_role: "user",
    evidence_ref: evidenceRef,
    assertion_text: assertion,
    user_context: userContext
  });
}

function parseRoleSpans(raw: string): readonly RoleSpan[] | null {
  const source = raw.trim();
  if (source.length === 0) return null;
  const marker = /(?:^|\n)(User|Assistant): /gu;
  const matches = [...source.matchAll(marker)];
  if (matches.length === 0 || matches[0]?.index !== 0) return null;
  const spans: RoleSpan[] = [];
  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    const text = source.slice(start, end).trim();
    if (text.length === 0 || text.includes("\n")) return null;
    spans.push(Object.freeze({
      role: match[1] === "User" ? "user" : "assistant",
      text
    }));
  }
  return Object.freeze(spans);
}

function findUniqueUserAssertion(
  spans: readonly RoleSpan[],
  assertion: string
): Readonly<{ readonly text: string; readonly index: number }> | null {
  const occurrences = spans.flatMap((span) =>
    occurrenceIndexes(span.text, assertion).map((index) => ({ span, index }))
  );
  if (occurrences.length !== 1 || occurrences[0]?.span.role !== "user") return null;
  return Object.freeze({
    text: occurrences[0].span.text,
    index: occurrences[0].index
  });
}

function occurrenceIndexes(text: string, needle: string): readonly number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + Math.max(1, needle.length);
  }
  return indexes;
}

function buildSentenceWindow(text: string, start: number, length: number): string {
  const sentences = collectSentenceSpans(text);
  const anchoredStart = sentences.findIndex((span) =>
    start >= span.start && start < span.end
  );
  const assertionEnd = start + length;
  const anchoredEnd = sentences.findIndex((span) =>
    assertionEnd > span.start && assertionEnd <= span.end
  );
  if (anchoredStart < 0 || anchoredEnd < anchoredStart) return "";
  const windowStart = sentences[Math.max(0, anchoredStart - 1)]!.start;
  return text.slice(windowStart, sentences[anchoredEnd]!.end).trim();
}

function collectSentenceSpans(text: string): readonly SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = skipWhitespace(text, 0);
  for (let index = start; index < text.length; index += 1) {
    if (!/[.!?]/u.test(text[index] ?? "")) continue;
    if (index + 1 < text.length && !/\s/u.test(text[index + 1] ?? "")) continue;
    spans.push(Object.freeze({ start, end: index + 1 }));
    start = skipWhitespace(text, index + 1);
  }
  if (start < text.length) spans.push(Object.freeze({ start, end: text.length }));
  return Object.freeze(spans);
}

function skipWhitespace(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  return index;
}
