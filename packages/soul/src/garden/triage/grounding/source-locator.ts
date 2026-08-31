import { z } from "zod";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  buildSourceVerificationText,
  isAmbiguousBareStandaloneAssertion,
  PREFERENCE_SOURCE_ASSERTION_MAX_CHARS,
  resolveAtomicSourceAssertion,
  resolveSourceAssertion,
  SOURCE_ASSERTION_MAX_CHARS,
  type SourceAssertionResolution
} from "./source-assertion.js";
import { parseDirectPreferenceRelation } from "./preference-relation.js";
import {
  collectSourceRoleMarkers,
  sourceRoleMarkerPrefixLength,
  stripSourceRoleMarker
} from "./source-role/marker.js";
import {
  indexSourceAssertions,
  isDirectQuestionSourceText,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
  type OfficialApiSourceAssertion
} from "./source-locator/assertion-catalog.js";

export {
  isDirectQuestionSourceText,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION
} from "./source-locator/assertion-catalog.js";

const AssertionCatalogLocatorSchema = z.object({
  contract_version: z.literal(OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION),
  kind: z.literal("assertion_catalog"),
  assertion_id: z.number().int().positive()
}).strict().readonly();

export const OfficialApiSourceLocatorSchema = AssertionCatalogLocatorSchema;

export type OfficialApiSourceLocator = z.infer<typeof OfficialApiSourceLocatorSchema>;

export type { OfficialApiSourceAssertion } from "./source-locator/assertion-catalog.js";

export interface OfficialApiVerifiedUserAssertionSource {
  readonly source_corpus: string;
  readonly source_locator: OfficialApiSourceLocator;
}

export function parseOfficialApiSourceLocator(value: unknown): OfficialApiSourceLocator | null {
  const parsed = OfficialApiSourceLocatorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildOfficialApiSourceCorpus(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[]
): string {
  return canonicalSourceMessages(turnContent, messages)
    .map(({ source }) => source)
    .join("\n");
}

export function buildOfficialApiSourceAssertions(
  sourceText: string
): readonly OfficialApiSourceAssertion[] {
  const assertions = indexSourceAssertions(sourceText);
  if (assertions.length === 1 && isAmbiguousBareStandaloneAssertion(assertions[0]!.text)) return [];
  return Object.freeze(assertions.map(({ assertion_id, text }) =>
    Object.freeze({ assertion_id, text })
  ));
}

export function buildOfficialApiVerifiedUserAssertionSource(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  locator: OfficialApiSourceLocator | undefined,
  assertion: string,
  maxChars = 2_048
): OfficialApiVerifiedUserAssertionSource | null {
  const sourceText = buildOfficialApiSourceCorpus(turnContent, messages);
  const block = structuredUserAssertionBlock(turnContent, messages, assertion);
  if (block === null) return null;
  const sourceCorpus = boundUserSourceBlock(block, assertion, maxChars);
  if (sourceCorpus === null) return null;
  const sourceLocator = rebindOfficialApiSourceLocatorQuote(sourceCorpus, assertion, {
    sourceText,
    locator
  });
  return sourceLocator === null ? null : { source_corpus: sourceCorpus, source_locator: sourceLocator };
}

export function rebindOfficialApiSourceLocatorQuote(
  sourceText: string,
  assertion: string,
  preferred?: Readonly<{
    readonly sourceText: string;
    readonly locator: OfficialApiSourceLocator | undefined;
  }>
): OfficialApiSourceLocator | null {
  const maxChars = sourceAssertionMaxChars(assertion);
  const original = preferred?.locator === undefined
    ? null
    : resolveOfficialApiSourceLocator(preferred.sourceText, preferred.locator, maxChars);
  const originalAssertion = original?.status === "grounded" ? original.assertion : null;
  const catalog = [...buildOfficialApiSourceAssertions(sourceText)].sort((left, right) =>
    locatorPreference(left.text, right.text, assertion, originalAssertion)
  );
  for (const candidate of catalog) {
    const rebound = catalogLocator(candidate.assertion_id);
    const resolution = resolveOfficialApiSourceLocatorQuote(sourceText, rebound, assertion, maxChars);
    if (resolution.status === "grounded" && resolution.assertion === assertion) return rebound;
  }
  return null;
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

function structuredUserAssertionBlock(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  assertion: string
): string | null {
  const matches = canonicalSourceMessages(turnContent, messages).filter(({ role, source }) =>
    role === "user" && source.includes(assertion)
  );
  if (matches.length !== 1) return null;
  const source = matches[0]!.source;
  const offset = source.indexOf(assertion);
  return source.indexOf(assertion, offset + 1) < 0 ? source : null;
}

function boundUserSourceBlock(
  block: string,
  assertion: string,
  maxChars: number
): string | null {
  if (maxChars <= "User: ".length || block.length === 0) return null;
  if (block.length <= maxChars) return block;
  const prefixLength = sourceRoleMarkerPrefixLength(block);
  if (prefixLength === 0) return null;
  const bounded = buildSourceVerificationText(
    block.slice(prefixLength),
    assertion,
    maxChars - "User: ".length
  );
  return bounded.includes(assertion) ? `User: ${bounded}` : null;
}

function locatorPreference(
  left: string,
  right: string,
  assertion: string,
  originalAssertion: string | null
): number {
  const priority = (value: string): number =>
    value === assertion ? 0 : value === originalAssertion ? 1 : 2;
  return priority(left) - priority(right);
}

export function sourceAssertionMaxChars(assertion: string): number {
  return parseDirectPreferenceRelation(assertion) === undefined
    ? SOURCE_ASSERTION_MAX_CHARS
    : PREFERENCE_SOURCE_ASSERTION_MAX_CHARS;
}

function catalogLocator(assertionId: number): OfficialApiSourceLocator {
  return {
    contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
    kind: "assertion_catalog",
    assertion_id: assertionId
  };
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

function roleLabel(role: "user" | "assistant"): "User" | "Assistant" {
  return role === "user" ? "User" : "Assistant";
}

function canonicalSourceMessages(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[]
): readonly Readonly<{ role: "user" | "assistant"; source: string }>[] {
  const sourceMessages = messages.length === 0
    ? [{ role: "user" as const, content: turnContent }]
    : messages;
  return sourceMessages.map((message) => ({
    role: message.role,
    source: `${roleLabel(message.role)}: ${canonicalMessageContent(message.content)}`
  }));
}

function canonicalMessageContent(content: string): string {
  return content.trim().replace(/\s*[\r\n\u2028\u2029]+\s*/gu, " ");
}

function rejectedLocator(): SourceAssertionResolution {
  return { status: "rejected", reason: "source_assertion_not_self_contained" };
}

function rejectedQuote(): SourceAssertionResolution {
  return { status: "rejected", reason: "matched_text_absent" };
}
