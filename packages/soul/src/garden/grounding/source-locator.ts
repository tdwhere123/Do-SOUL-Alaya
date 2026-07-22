import { z } from "zod";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import { resolveSourceAssertion, type SourceAssertionResolution } from "./source-assertion.js";
import { isBoundedTemplateSlotAssertion } from "./source-assertion/reference-closure.js";
import {
  coordinateSpans,
  sentenceSpans,
  type AssertionSpan
} from "./source-assertion/clause-spans.js";

export const OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION = 2;
const LEGACY_SENTENCE_RANGE_CONTRACT_VERSION = 1;
const MAX_LOCATOR_SPANS = 2;
const MAX_SOURCE_ASSERTIONS = 64;

const ExactSentenceRangeLocatorSchema = z.object({
  contract_version: z.literal(LEGACY_SENTENCE_RANGE_CONTRACT_VERSION),
  kind: z.literal("exact_sentence_range"),
  start_span: z.number().int().positive(),
  end_span: z.number().int().positive()
}).strict().refine(
  (locator) => locator.end_span >= locator.start_span &&
    locator.end_span - locator.start_span + 1 <= MAX_LOCATOR_SPANS
).readonly();

const AssertionCatalogLocatorSchema = z.object({
  contract_version: z.literal(OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION),
  kind: z.literal("assertion_catalog"),
  assertion_id: z.number().int().positive()
}).strict().readonly();

export const OfficialApiSourceLocatorSchema = z.union([
  AssertionCatalogLocatorSchema,
  ExactSentenceRangeLocatorSchema
]).readonly();

export type OfficialApiSourceLocator = z.infer<typeof OfficialApiSourceLocatorSchema>;

export interface OfficialApiSourceSpan {
  readonly span_id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface OfficialApiSourceAssertion {
  readonly assertion_id: number;
  readonly text: string;
}

interface IndexedSourceSpan extends OfficialApiSourceSpan {
  readonly start: number;
  readonly end: number;
}

interface IndexedSourceAssertion extends OfficialApiSourceAssertion {
  readonly start: number;
  readonly end: number;
  readonly sentence: AssertionSpan;
}

export function parseOfficialApiSourceLocator(value: unknown): OfficialApiSourceLocator | null {
  const parsed = OfficialApiSourceLocatorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildOfficialApiSourceCorpus(
  turnContent: string,
  messages: readonly ConversationMessage[]
): string {
  const source = messages.length === 0
    ? `User: ${canonicalMessageContent(turnContent)}`
    : messages.map((message) =>
      `${roleLabel(message.role)}: ${canonicalMessageContent(message.content)}`
    ).join("\n");
  return source;
}

export function buildOfficialApiSourceSpans(sourceText: string): readonly OfficialApiSourceSpan[] {
  return Object.freeze(indexSourceSpans(sourceText).map(({ span_id, role, text }) =>
    Object.freeze({ span_id, role, text })
  ));
}

export function buildOfficialApiSourceAssertions(
  sourceText: string
): readonly OfficialApiSourceAssertion[] {
  return Object.freeze(indexSourceAssertions(sourceText).map(({ assertion_id, text }) =>
    Object.freeze({ assertion_id, text })
  ));
}

export function resolveOfficialApiSourceLocator(
  sourceText: string,
  locator: OfficialApiSourceLocator
): SourceAssertionResolution {
  if (locator.kind === "assertion_catalog") {
    return resolveAssertionCatalogLocator(sourceText, locator.assertion_id);
  }
  if (locator.end_span < locator.start_span ||
      locator.end_span - locator.start_span + 1 > MAX_LOCATOR_SPANS) {
    return rejectedRange();
  }
  const spans = indexSourceSpans(sourceText);
  const selected = spans.slice(locator.start_span - 1, locator.end_span);
  if (selected.length !== locator.end_span - locator.start_span + 1 ||
      selected.some((span) => span.role !== "user")) {
    return rejectedRange();
  }
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return rejectedRange();
  const selectedText = sourceText.slice(first.start, last.end);
  if (hasDirectQuestion(selected)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  return resolveSourceAssertion(sourceText, selectedText);
}

export function locatorAssertionUniquelyCommitsToQuote(
  sourceText: string,
  assertion: string,
  proposedText: string
): boolean {
  const quote = proposedText.trim();
  if (quote.length === 0 || !assertion.includes(quote)) return false;
  const first = sourceText.indexOf(quote);
  return first >= 0 && sourceText.indexOf(quote, first + 1) < 0;
}

function resolveAssertionCatalogLocator(
  sourceText: string,
  assertionId: number
): SourceAssertionResolution {
  const selected = indexSourceAssertions(sourceText)[assertionId - 1];
  if (selected === undefined) return rejectedRange();
  const sentenceText = sourceText.slice(selected.sentence.start, selected.sentence.end);
  if (hasDirectQuestionText(sentenceText)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  const assertionText = sourceText.slice(selected.start, selected.end);
  return resolveSourceAssertion(sentenceText, assertionText);
}

function hasDirectQuestion(selected: readonly IndexedSourceSpan[]): boolean {
  return selected.some((span) => hasDirectQuestionText(span.text));
}

function hasDirectQuestionText(text: string): boolean {
  const content = stripRoleLabel(text);
  if (!content.endsWith("?")) return false;
  return boundedIndirectQuestionPrefix(content) === null;
}

function boundedIndirectQuestionPrefix(content: string): string | null {
  const kinship = "sister|brother|mother|father|aunt|uncle|cousin|niece|nephew|daughter|son|wife|husband|partner|friend";
  const person = "\\p{Lu}[\\p{L}'’-]*";
  const place = "(?:the\\s+)?\\p{Lu}[\\p{L}\\p{N}'’.-]*(?:\\s+\\p{Lu}[\\p{L}\\p{N}'’.-]*){0,3}";
  const pattern = new RegExp(
    `^((?:I['’]m|I am)\\s+thinking\\s+of\\s+visiting\\s+(?:my|our)\\s+(?:${kinship})\\s+${person}\\s+in\\s+${place}(?:\\s+soon)?),\\s+and\\s+I\\s+was\\s+wondering\\s+(?:if|whether)\\b[^?,;:—–]*\\?$`,
    "u"
  );
  return pattern.exec(content)?.[1]?.trim() ?? null;
}

function indexSourceAssertions(sourceText: string): readonly IndexedSourceAssertion[] {
  const roleMarkers = collectRoleMarkers(sourceText);
  const sentences = sentenceSpans(sourceText);
  const output: IndexedSourceAssertion[] = [];
  const seen = new Set<string>();
  for (const [index, sentence] of sentences.entries()) {
    if (roleAt(roleMarkers, sentence.start) !== "user") continue;
    const sentenceText = sourceText.slice(sentence.start, sentence.end);
    if (hasDirectQuestionText(sentenceText)) continue;
    if (appendBoundedIndirectQuestionPrefix(output, seen, sourceText, sentence, sentenceText)) {
      continue;
    }
    appendAssertion(output, seen, sourceText, sentence, sentence);
    for (const clause of coordinateSpans(sourceText, sentence)) {
      appendAssertion(output, seen, sourceText, clause, sentence);
    }
    appendBoundedTemplateSlotPair(output, seen, sourceText, roleMarkers, sentence, sentences[index + 1]);
  }
  return selectBoundedAssertions(output);
}

function appendBoundedIndirectQuestionPrefix(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  sentence: AssertionSpan,
  sentenceText: string
): boolean {
  const content = stripRoleLabel(sentenceText);
  const prefix = boundedIndirectQuestionPrefix(content);
  if (prefix === null) return false;
  const localStart = sentenceText.indexOf(prefix);
  if (localStart < 0) return false;
  const span = {
    start: sentence.start + localStart,
    end: sentence.start + localStart + prefix.length
  };
  appendAssertion(output, seen, sourceText, span, sentence);
  return true;
}

function appendBoundedTemplateSlotPair(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  roleMarkers: readonly { readonly start: number; readonly role: "user" | "assistant" }[],
  first: AssertionSpan,
  second: AssertionSpan | undefined
): void {
  if (second === undefined || roleAt(roleMarkers, second.start) !== "user") return;
  const pair = { start: first.start, end: second.end };
  if (!isBoundedTemplateSlotAssertion(sourceText.slice(pair.start, pair.end))) return;
  appendAssertion(output, seen, sourceText, pair, pair);
}

function appendAssertion(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  span: AssertionSpan,
  sentence: AssertionSpan
): void {
  const key = `${span.start}:${span.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  const assertionText = sourceText.slice(span.start, span.end);
  const sentenceText = sourceText.slice(sentence.start, sentence.end);
  const resolution = resolveSourceAssertion(sentenceText, assertionText);
  if (resolution.status !== "grounded" ||
      stripRoleLabel(resolution.assertion) !== stripRoleLabel(assertionText)) return;
  output.push({
    assertion_id: output.length + 1,
    text: assertionText,
    start: span.start,
    end: span.end,
    sentence
  });
}

function selectBoundedAssertions(
  assertions: readonly IndexedSourceAssertion[]
): readonly IndexedSourceAssertion[] {
  if (assertions.length <= MAX_SOURCE_ASSERTIONS) return assertions;
  const lastIndex = assertions.length - 1;
  return Array.from({ length: MAX_SOURCE_ASSERTIONS }, (_, outputIndex) => {
    const sourceIndex = Math.round(outputIndex * lastIndex / (MAX_SOURCE_ASSERTIONS - 1));
    const selected = assertions[sourceIndex]!;
    return { ...selected, assertion_id: outputIndex + 1 };
  });
}

function indexSourceSpans(sourceText: string): readonly IndexedSourceSpan[] {
  const roleMarkers = collectRoleMarkers(sourceText);
  return sentenceSpans(sourceText).map((span, index) => ({
    span_id: index + 1,
    role: roleAt(roleMarkers, span.start),
    text: sourceText.slice(span.start, span.end),
    start: span.start,
    end: span.end
  }));
}

function collectRoleMarkers(sourceText: string): readonly {
  readonly start: number;
  readonly role: "user" | "assistant";
}[] {
  const markers: { start: number; role: "user" | "assistant" }[] = [];
  for (const match of sourceText.matchAll(/^(User|Assistant)\s*:/gimu)) {
    markers.push({ start: match.index, role: match[1]!.toLowerCase() as "user" | "assistant" });
  }
  return markers;
}

function stripRoleLabel(text: string): string {
  return text.trim().replace(/^(?:User|Assistant)\s*:\s*/iu, "").trim();
}

function roleAt(
  markers: readonly { readonly start: number; readonly role: "user" | "assistant" }[],
  offset: number
): "user" | "assistant" {
  let role: "user" | "assistant" = "user";
  for (const marker of markers) {
    if (marker.start > offset) break;
    role = marker.role;
  }
  return role;
}

function roleLabel(role: "user" | "assistant"): "User" | "Assistant" {
  return role === "user" ? "User" : "Assistant";
}

function canonicalMessageContent(content: string): string {
  return content.trim().replace(/\s*[\r\n]+\s*/gu, " ");
}

function rejectedRange(): SourceAssertionResolution {
  return { status: "rejected", reason: "source_assertion_not_self_contained" };
}
