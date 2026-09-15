import { VERIFIED_USER_ASSERTION_CATALOG_CONTRACT_VERSION } from "@do-soul/alaya-protocol";
import {
  PREFERENCE_SOURCE_ASSERTION_MAX_CHARS,
  resolveAtomicSourceAssertion,
  resolveSourceAssertion,
  SOURCE_ASSERTION_MAX_CHARS
} from "../source-assertion.js";
import { parseDirectPreferenceRelation } from "../preference-relation.js";
import { isBoundedTemplateSlotAssertion } from "../source-assertion/reference-closure.js";
import {
  coordinateSpans,
  sentenceSpans,
  type AssertionSpan
} from "../source-assertion/clause-spans.js";
import { atomicAssertionSpans } from "../source-assertion/atomic-spans.js";
import { boundedIndirectQuestionPrefix, sourceAssertionPreservesScope } from "../source-assertion/scope.js";
import {
  collectSourceRoleMarkers,
  stripSourceRoleMarker,
  type SourceConversationRole,
  type SourceRoleMarker
} from "../source-role/marker.js";

export const OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION = VERIFIED_USER_ASSERTION_CATALOG_CONTRACT_VERSION;
export const SOURCE_ASSERTION_CATALOG_PRODUCER = "official-api-source-assertion-catalog-v4" as const;
export const SOURCE_ASSERTION_CATALOG_PAGE_SIZE = 64;
export const MAX_SOURCE_ASSERTIONS = SOURCE_ASSERTION_CATALOG_PAGE_SIZE;

export interface OfficialApiSourceAssertion {
  readonly assertion_id: number;
  readonly text: string;
}

export interface IndexedSourceAssertion extends OfficialApiSourceAssertion {
  readonly start: number;
  readonly end: number;
  readonly sentence: AssertionSpan;
  readonly atomic: boolean;
}

export interface SourceAssertionCatalogCursor {
  readonly after_assertion_id: number;
}

type SourceAssertionCatalogCoverage = "source_range_complete" | "budget_complete";

interface SourceAssertionCatalogResidualMember {
  readonly assertion_id: number;
  readonly start: number;
  readonly end: number;
}

export interface SourceAssertionCatalogPage {
  readonly contract_version: typeof OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION;
  readonly producer: typeof SOURCE_ASSERTION_CATALOG_PRODUCER;
  readonly inventory_count: number;
  readonly window: readonly IndexedSourceAssertion[];
  readonly residual: readonly SourceAssertionCatalogResidualMember[];
  readonly next_cursor: SourceAssertionCatalogCursor | null;
  readonly coverage: SourceAssertionCatalogCoverage;
}

export function isDirectQuestionSourceText(text: string): boolean {
  const content = stripSourceRoleMarker(text);
  if (!/[?？]$/u.test(content)) return false;
  return boundedIndirectQuestionPrefix(content) === null;
}

export function indexSourceAssertions(sourceText: string): readonly IndexedSourceAssertion[] {
  const output = [...indexLegacySourceAssertions(sourceText)];
  const roleMarkers = collectSourceRoleMarkers(sourceText);
  const seen = new Set(output.map((assertion) => `${assertion.start}:${assertion.end}`));
  for (const sentence of sentenceSpans(sourceText)) {
    if (roleAt(roleMarkers, sentence.start) !== "user") continue;
    for (const atom of atomicAssertionSpans(sourceText, sentence)) {
      if (isCoveredByCatalogAssertion(output, atom)) continue;
      appendAssertion(output, seen, sourceText, atom, sentence, true);
    }
  }
  return output;
}

export function pageSourceAssertionCatalog(
  sourceText: string,
  cursor?: SourceAssertionCatalogCursor | null,
  pageSize = SOURCE_ASSERTION_CATALOG_PAGE_SIZE
): SourceAssertionCatalogPage {
  return pageSourceAssertionInventory(indexSourceAssertions(sourceText), cursor, pageSize);
}

export function pageSourceAssertionInventory(
  inventory: readonly IndexedSourceAssertion[],
  cursor?: SourceAssertionCatalogCursor | null,
  pageSize = SOURCE_ASSERTION_CATALOG_PAGE_SIZE
): SourceAssertionCatalogPage {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new TypeError("catalog page size must be a positive integer");
  }
  if (cursor !== undefined && cursor !== null) {
    if (!Number.isInteger(cursor.after_assertion_id) || cursor.after_assertion_id < 1) {
      throw new TypeError("catalog cursor after_assertion_id must be a positive integer");
    }
  }
  const startIndex = cursor === undefined || cursor === null
    ? 0
    : inventory.findIndex((item) => item.assertion_id > cursor.after_assertion_id);
  const from = startIndex < 0 ? inventory.length : startIndex;
  const window = inventory.slice(from, from + pageSize);
  const rest = inventory.slice(from + window.length);
  const residual = rest.map((item) => Object.freeze({
    assertion_id: item.assertion_id,
    start: item.start,
    end: item.end
  }));
  const nextCursor = residual.length === 0 || window.length === 0
    ? null
    : { after_assertion_id: window[window.length - 1]!.assertion_id };
  return Object.freeze({
    contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
    producer: SOURCE_ASSERTION_CATALOG_PRODUCER,
    inventory_count: inventory.length,
    window: Object.freeze([...window]),
    residual: Object.freeze(residual),
    next_cursor: nextCursor,
    coverage: residual.length === 0 ? "source_range_complete" as const : "budget_complete" as const
  });
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
  if (!sourceAssertionPreservesScope(sourceText, span.start, span.end)) return;
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
