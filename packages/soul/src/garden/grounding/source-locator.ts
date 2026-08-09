import { z } from "zod";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  PREFERENCE_SOURCE_ASSERTION_MAX_CHARS,
  resolveAtomicSourceAssertion,
  resolveSourceAssertion,
  SOURCE_ASSERTION_MAX_CHARS,
  type SourceAssertionResolution
} from "./source-assertion.js";
import { parseDirectPreferenceRelation } from "./preference-relation.js";
import { isBoundedTemplateSlotAssertion } from "./source-assertion/reference-closure.js";
import {
  coordinateSpans,
  sentenceSpans,
  type AssertionSpan
} from "./source-assertion/clause-spans.js";
import { atomicAssertionSpans } from "./source-assertion/atomic-spans.js";
import {
  collectSourceRoleMarkers,
  stripSourceRoleMarker,
  type SourceConversationRole,
  type SourceRoleMarker
} from "./source-role/marker.js";

export const OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION = 2;
const MAX_SOURCE_ASSERTIONS = 64;

const AssertionCatalogLocatorSchema = z.object({
  contract_version: z.literal(OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION),
  kind: z.literal("assertion_catalog"),
  assertion_id: z.number().int().positive()
}).strict().readonly();

export const OfficialApiSourceLocatorSchema = AssertionCatalogLocatorSchema;

export type OfficialApiSourceLocator = z.infer<typeof OfficialApiSourceLocatorSchema>;

export interface OfficialApiSourceAssertion {
  readonly assertion_id: number;
  readonly text: string;
}

interface IndexedSourceAssertion extends OfficialApiSourceAssertion {
  readonly start: number;
  readonly end: number;
  readonly sentence: AssertionSpan;
  readonly atomic: boolean;
}

export function parseOfficialApiSourceLocator(value: unknown): OfficialApiSourceLocator | null {
  const parsed = OfficialApiSourceLocatorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildOfficialApiSourceCorpus(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[]
): string {
  const source = messages.length === 0
    ? `User: ${canonicalMessageContent(turnContent)}`
    : messages.map((message) =>
      `${roleLabel(message.role)}: ${canonicalMessageContent(message.content)}`
    ).join("\n");
  return source;
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
  locator: OfficialApiSourceLocator,
  maxChars = SOURCE_ASSERTION_MAX_CHARS
): SourceAssertionResolution {
  return resolveAssertionCatalogLocator(sourceText, locator.assertion_id, maxChars);
}

export function resolveOfficialApiSourceLocatorQuote(
  sourceText: string,
  locator: OfficialApiSourceLocator,
  proposedText: string,
  maxChars = SOURCE_ASSERTION_MAX_CHARS
): SourceAssertionResolution {
  const located = resolveOfficialApiSourceLocator(sourceText, locator, maxChars);
  if (located.status === "rejected") return located;
  if (locatorAssertionUniquelyCommitsToQuote(sourceText, located.assertion, proposedText)) {
    return located;
  }
  return resolveCatalogVerbatimQuote(
    sourceText,
    locator.assertion_id,
    proposedText,
    maxChars
  );
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
  assertionId: number,
  maxChars: number
): SourceAssertionResolution {
  const selected = indexSourceAssertions(sourceText)[assertionId - 1];
  if (selected === undefined) return rejectedLocator();
  const sentenceText = sourceText.slice(selected.sentence.start, selected.sentence.end);
  const assertionText = sourceText.slice(selected.start, selected.end);
  return selected.atomic
    ? resolveAtomicSourceAssertion(assertionText, maxChars)
    : resolveSourceAssertion(sentenceText, assertionText, maxChars);
}

function resolveCatalogVerbatimQuote(
  sourceText: string,
  assertionId: number,
  proposedText: string,
  maxChars: number
): SourceAssertionResolution {
  const quote = proposedText.trim();
  if (quote.length === 0 || quote.length > maxChars) {
    return resolveSourceAssertion(sourceText, quote, maxChars);
  }
  if (isDirectQuestionSourceText(quote)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  const offset = sourceText.indexOf(quote);
  if (offset < 0) return rejectedQuote();
  if (sourceText.indexOf(quote, offset + 1) >= 0) {
    return { status: "rejected", reason: "matched_text_ambiguous" };
  }
  const selected = indexSourceAssertions(sourceText)[assertionId - 1];
  const markers = collectSourceRoleMarkers(sourceText);
  const selectedBlock = selected === undefined ? null : sourceMessageBlockAt(markers, selected.start, sourceText.length);
  const quoteBlock = sourceMessageBlockAt(markers, offset, sourceText.length);
  if (selectedBlock === null || quoteBlock === null || selectedBlock.role !== "user" ||
      quoteBlock.role !== "user" || selectedBlock.start !== quoteBlock.start) {
    return rejectedQuote();
  }
  const resolution = resolveSourceAssertion(
    sourceText.slice(quoteBlock.start, quoteBlock.end),
    quote,
    maxChars
  );
  if (resolution.status === "grounded" || resolution.reason !== "source_assertion_not_self_contained") {
    return resolution;
  }
  if (!isRecoverableVerbatimUserQuote(quote, maxChars)) return resolution;
  return { status: "grounded", assertion: stripSourceRoleMarker(quote) };
}

function sourceMessageBlockAt(
  markers: readonly { readonly start: number; readonly role: "user" | "assistant" }[],
  offset: number,
  sourceLength: number
): { readonly start: number; readonly end: number; readonly role: "user" | "assistant" } | null {
  let index = -1;
  for (const [candidateIndex, marker] of markers.entries()) {
    if (marker.start > offset) break;
    index = candidateIndex;
  }
  if (index < 0) return null;
  const marker = markers[index]!;
  return { start: marker.start, end: markers[index + 1]?.start ?? sourceLength, role: marker.role };
}

function isRecoverableVerbatimUserQuote(value: string, maxChars: number): boolean {
  const quote = stripSourceRoleMarker(value);
  if (quote.length === 0 || quote.length > maxChars || /[?？]/u.test(quote)) {
    return false;
  }
  if (/^(?:(?:by the way|anyway|actually|well|speaking of)\s*,?\s*)?(?:i|we)\b/iu.test(quote)) {
    return true;
  }
  return /^it\s+(?:took|takes|will\s+take)\s+me\b/iu.test(quote);
}

export function isDirectQuestionSourceText(text: string): boolean {
  const content = stripSourceRoleMarker(text);
  if (!/[?？]$/u.test(content)) return false;
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
  const legacy = indexLegacySourceAssertions(sourceText);
  const output = [...selectBoundedAssertions(legacy)];
  if (output.length >= MAX_SOURCE_ASSERTIONS) return output;

  const roleMarkers = collectSourceRoleMarkers(sourceText);
  const seen = new Set(legacy.map((assertion) => `${assertion.start}:${assertion.end}`));
  for (const sentence of sentenceSpans(sourceText)) {
    if (roleAt(roleMarkers, sentence.start) !== "user") continue;
    for (const atom of atomicAssertionSpans(sourceText, sentence)) {
      if (output.length >= MAX_SOURCE_ASSERTIONS) return output;
      if (isCoveredByCatalogAssertion(output, atom)) continue;
      appendAssertion(output, seen, sourceText, atom, sentence, true);
    }
    if (output.length >= MAX_SOURCE_ASSERTIONS) break;
  }
  return output;
}

function indexLegacySourceAssertions(
  sourceText: string,
  preferenceMaxChars = PREFERENCE_SOURCE_ASSERTION_MAX_CHARS
): readonly IndexedSourceAssertion[] {
  const roleMarkers = collectSourceRoleMarkers(sourceText);
  const sentences = sentenceSpans(sourceText);
  const output: IndexedSourceAssertion[] = [];
  const seen = new Set<string>();
  for (const [index, sentence] of sentences.entries()) {
    if (roleAt(roleMarkers, sentence.start) !== "user") continue;
    const sentenceText = sourceText.slice(sentence.start, sentence.end);
    if (isDirectQuestionSourceText(sentenceText)) continue;
    if (appendBoundedIndirectQuestionPrefix(
      output,
      seen,
      sourceText,
      sentence,
      sentenceText,
      preferenceMaxChars
    )) {
      continue;
    }
    appendAssertion(output, seen, sourceText, sentence, sentence, false, preferenceMaxChars);
    for (const clause of coordinateSpans(sourceText, sentence)) {
      appendAssertion(output, seen, sourceText, clause, sentence, false, preferenceMaxChars);
    }
    appendBoundedTemplateSlotPair(
      output,
      seen,
      sourceText,
      roleMarkers,
      sentence,
      sentences[index + 1],
      preferenceMaxChars
    );
  }
  return output;
}

function appendBoundedIndirectQuestionPrefix(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  sentence: AssertionSpan,
  sentenceText: string,
  preferenceMaxChars: number
): boolean {
  const content = stripSourceRoleMarker(sentenceText);
  const prefix = boundedIndirectQuestionPrefix(content);
  if (prefix === null) return false;
  const localStart = sentenceText.indexOf(prefix);
  if (localStart < 0) return false;
  const span = {
    start: sentence.start + localStart,
    end: sentence.start + localStart + prefix.length
  };
  appendAssertion(output, seen, sourceText, span, sentence, false, preferenceMaxChars);
  return true;
}

function appendBoundedTemplateSlotPair(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  roleMarkers: readonly SourceRoleMarker[],
  first: AssertionSpan,
  second: AssertionSpan | undefined,
  preferenceMaxChars: number
): void {
  if (second === undefined || roleAt(roleMarkers, second.start) !== "user") return;
  const pair = { start: first.start, end: second.end };
  if (!isBoundedTemplateSlotAssertion(sourceText.slice(pair.start, pair.end))) return;
  appendAssertion(output, seen, sourceText, pair, pair, false, preferenceMaxChars);
}

function appendAssertion(
  output: IndexedSourceAssertion[],
  seen: Set<string>,
  sourceText: string,
  span: AssertionSpan,
  sentence: AssertionSpan,
  atomic = false,
  preferenceMaxChars = PREFERENCE_SOURCE_ASSERTION_MAX_CHARS
): void {
  const key = `${span.start}:${span.end}`;
  if (seen.has(key)) return;
  seen.add(key);
  const assertionText = sourceText.slice(span.start, span.end);
  const sentenceText = sourceText.slice(sentence.start, sentence.end);
  const maxChars = parseDirectPreferenceRelation(assertionText) === undefined
    ? SOURCE_ASSERTION_MAX_CHARS
    : preferenceMaxChars;
  const resolution = atomic
    ? resolveAtomicSourceAssertion(assertionText, maxChars)
    : resolveSourceAssertion(sentenceText, assertionText, maxChars);
  if (resolution.status !== "grounded" ||
      stripSourceRoleMarker(resolution.assertion) !== stripSourceRoleMarker(assertionText)) return;
  output.push({
    assertion_id: output.length + 1,
    text: assertionText,
    start: span.start,
    end: span.end,
    sentence,
    atomic
  });
}

function isCoveredByCatalogAssertion(
  assertions: readonly IndexedSourceAssertion[],
  span: AssertionSpan
): boolean {
  return assertions.some((assertion) => assertion.start <= span.start && assertion.end >= span.end);
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

function roleAt(
  markers: readonly SourceRoleMarker[],
  offset: number
): SourceConversationRole {
  let role: SourceConversationRole = "user";
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

function rejectedLocator(): SourceAssertionResolution {
  return { status: "rejected", reason: "source_assertion_not_self_contained" };
}

function rejectedQuote(): SourceAssertionResolution {
  return { status: "rejected", reason: "matched_text_absent" };
}
