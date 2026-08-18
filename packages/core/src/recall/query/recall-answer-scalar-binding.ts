import type { RecallAnswerShape, RecallAnswerShapePlan } from "./recall-answer-shape-plan.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { splitLexicalTokens } from "./recall-query-probes.js";

export type RecallScalarEventStatus = "asserted" | "prospective" | "negated" | "reversed";
export type RecallScalarTimeStatus = "not_requested" | "compatible" | "conflicted" | "unknown";
export type RecallScalarTargetStatus = "bound" | "partial" | "missing";
export type RecallScalarRelationStatus = "bound" | "conflicted" | "missing";

export interface RecallScalarBindingAssessment {
  readonly unique: true;
  readonly subject_status: "bound";
  readonly target_status: "bound";
  readonly relation_status: "bound";
  readonly event_status: RecallScalarEventStatus;
  readonly time_status: RecallScalarTimeStatus;
}

const PLACE_VALUE_CUES = [
  /\bfrom\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\bat\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\bin\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\bnear\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\binside\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\boutside\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\b(?:located|based)\s+in\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu,
  /\b(?:going|went|travelled|traveled|visited|stayed)\s+to\s+(?:the\s+)?(?<value>[\p{L}\p{N}][\p{L}\p{N}'’_-]*%?)/giu
] as const;
const DURATION_VALUE_SOURCE =
  String.raw`\b(?:(?:over|under|about|around|nearly|more\s+than|less\s+than)\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a|an|half)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b`;
const DURATION_VALUE_CUE = new RegExp(DURATION_VALUE_SOURCE, "iu");
const LEADING_DURATION_VALUE_CUE = new RegExp(`^\\s*${DURATION_VALUE_SOURCE}`, "iu");
const NON_PLACE_VALUES = new Set([
  "budget", "completion", "done", "finished", "january", "february", "march",
  "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday"
]);

const RELATION_ALIASES: readonly ReadonlySet<string>[] = [
  new Set(["buy", "bought", "purchase", "purchased", "from"]),
  new Set(["wait", "waited", "waiting"]),
  new Set(["attend", "attended", "visit", "visited"]),
  new Set(["live", "lived", "located", "based"]),
  new Set(["meet", "met"]),
  new Set(["redeem", "redeemed"]),
  new Set(["spend", "spent", "pay", "paid", "cost", "costs"])
];
const PURCHASE_RELATIONS = new Set(["buy", "bought", "purchase", "purchased"]);
const PURCHASE_CONFLICTS = new Set([
  "borrowed", "gifted", "inherited", "manufactured", "received", "rented",
  "repaired", "returned", "refunded", "shipped", "sold", "won"
]);
const DIRECT_SELF_PURCHASE =
  /^\s*i\s+(?:(?:just|recently|finally|actually|also|already)\s+){0,2}(?<verb>buy|bought|purchase|purchased)\b/iu;
const WAIT_RELATION = new Set(["wait", "waited", "waiting"]);
const SELF_ACTOR = /\bi\b|\bi['’](?:m|ve|d|ll)\b/iu;
const SELF_OWNED_TARGET_MODIFIERS = new Set([
  "current", "favorite", "favourite", "latest", "new", "old", "own", "replacement"
]);
const ORIGIN_TARGET_PREFIX_TERMS = new Set([
  ...SELF_OWNED_TARGET_MODIFIERS, "a", "an", "the"
]);
const PURCHASE_TARGET_CLAUSE_TERMS = new Set([
  ...ORIGIN_TARGET_PREFIX_TERMS, "my"
]);
const DIRECT_PURCHASE_PLACE_TAIL =
  /^\s*from\s+(?:the\s+)?[\p{L}\p{N}][\p{L}\p{N}'’_-]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}'’_-]*){0,2}\s*[.!?]?\s*$/u;
const ORIGIN_PLACE_TAIL =
  /^\s*(?:is|was|came)\s+from\s+(?:the\s+)?[\p{L}\p{N}][\p{L}\p{N}'’_-]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}'’_-]*){0,2}(?:\s*,\s*(?:and\s+)?[Ii](?:['’]m|\s+am)\s+(?:(?:really|very|so|quite|pretty|extremely)\s+)?(?:happy|pleased|satisfied|thrilled|excited|content)\s+(?:with|about)\s+(?:it|that|this))?\s*[.!?]?\s*$/u;
const DURATION_CONTINUATION = new RegExp(
  `^\\s*${DURATION_VALUE_SOURCE}\\s+(?:of\\s+)?(?:waiting|uncertainty|delay|processing|process|ordeal|limbo|stress)` +
  String.raw`(?:\s+(?:(?:was|is|felt|seemed|has\s+been|had\s+been)\s+)?` +
  String.raw`(?:(?:really|very|extremely)\s+)?(?:tough|difficult|hard|exhausting|stressful|frustrating|painful|rough|awful|terrible))?` +
  String.raw`\s*[.!?]?\s*$`,
  "iu"
);
const DURATION_OFFSET = /\b(?:ago|later|before|after|since)\b/iu;
const DIRECT_DURATION_EVENT =
  /^\s*i\s+(?:(?:already|finally|had|have|just|recently)\s+){0,2}wait(?:ed|ing)?\b(?<body>[^,;.!?]*)[.!?]?\s*$/iu;
const POSSESSIVE_DURATION_CONTEXT =
  /^\s*(?:speaking\s+of\s+waiting\s*,\s*)?my\b(?<body>[^,;.!?]{1,160})[.!?]?\s*$/iu;
const POSSESSIVE_DURATION_TAKEN_CONTEXT =
  /^\s*(?:by\s+the\s+way\s*,\s*)?(?:speaking\s+of\s+waiting\s*,\s*)?it(?:['’]s|\s+is)\s+(?:(?:really|so|pretty)\s+)?(?:crazy|hard|wild|surprising)\s+how\s+long\s+it\s+took\s+for\s+my\b(?<body>[^,;.!?]{1,160})[.!?]?\s*$/iu;
const DURATION_DIRECT_BODY_TERMS = new Set([
  "a", "an", "about", "around", "day", "days", "eight", "five", "for", "four",
  "half", "hour", "hours", "less", "minute", "minutes", "month", "months", "more",
  "my", "nearly", "nine", "of", "on", "one", "over", "second", "seconds", "seven",
  "six", "ten", "than", "the", "three", "to", "two", "under", "week", "weeks",
  "year", "years"
]);
const DURATION_CONTEXT_BODY_TERMS = new Set([
  "accepted", "approved", "been", "decided", "finally", "had", "has", "is",
  "get", "pending", "processed", "rejected", "resolved", "still", "to", "was"
]);
const DURATION_CONTEXT_STATUS_TERMS = new Set([
  "accepted", "approved", "decided", "pending", "processed", "rejected", "resolved"
]);
const REVERSED_EVENT =
  /\b(?:returned|refunded|cancelled|canceled|retracted|reversed)\b/iu;
const NEGATED_EVENT = /\b(?:did\s+not|didn't|never|not)\b/iu;
const PROSPECTIVE_EVENT =
  /\b(?:consider(?:ed|ing)?|plan(?:ned|ning)?|hope(?:d|ing)?|intend(?:ed|ing)?|thinking\s+about|going\s+to|will|would|might|may|should|could|perhaps|maybe|wish(?:ed|ing)?|want(?:ed|ing)?|looking\s+to|try(?:ing|ied)?)\b/iu;
const PURCHASE_GAP_CONFLICT =
  /\b(?:after|before|while|when|hearing|heard|learning|learned|message|support)\b/iu;

export function assessRecallScalarBinding(
  plan: Readonly<RecallAnswerShapePlan>,
  probes: Readonly<RecallQueryProbes> | undefined,
  userContext: string,
  assertionText: string
): Readonly<RecallScalarBindingAssessment> | null {
  if (probes?.subject_hints.includes("self_reference") !== true) return null;
  const sentences = splitAssertionSentences(userContext);
  const anchored = sentences
    .map((sentence, index) => ({ sentence, index }))
    .filter(({ sentence }) => sentence.includes(assertionText));
  if (anchored.length !== 1) return null;
  const anchoredHit = anchored[0];
  if (anchoredHit === undefined) return null;
  if (plan.shape === "place") {
    return assessPlaceBinding(plan, probes, anchoredHit.sentence, assertionText);
  }
  if (plan.shape === "duration") {
    return assessDurationBinding(plan, probes, sentences, anchoredHit.index, assertionText);
  }
  return null;
}

export function matchRecallRelationTerms(
  relationTerms: readonly string[],
  contentTokens: ReadonlySet<string>
): readonly string[] {
  return relationTerms.filter((term) => {
    if (contentTokens.has(term)) return true;
    const family = RELATION_ALIASES.find((aliases) => aliases.has(term));
    return family !== undefined && [...family].some((alias) => contentTokens.has(alias));
  });
}

export function isRecallScalarRelationTerm(term: string): boolean {
  return RELATION_ALIASES.some((aliases) => aliases.has(term));
}

export function resolveRecallTargetStatus(
  targetTerms: readonly string[],
  tokens: ReadonlySet<string>
): RecallScalarTargetStatus {
  const matched = targetTerms.filter((term) => tokens.has(term)).length;
  if (matched === 0) return "missing";
  return matched >= Math.min(2, targetTerms.length) ? "bound" : "partial";
}

export function resolveRecallRelationStatus(
  relationTerms: readonly string[],
  tokens: ReadonlySet<string>
): RecallScalarRelationStatus {
  const purchaseConflict = relationTerms.some((term) => PURCHASE_RELATIONS.has(term)) &&
    [...PURCHASE_CONFLICTS].some((term) => tokens.has(term));
  if (purchaseConflict) return "conflicted";
  if (relationTerms.length === 0) return "bound";
  return matchRecallRelationTerms(relationTerms, tokens).length > 0 ? "bound" : "missing";
}

export function resolveRecallScalarEventStatus(text: string): RecallScalarEventStatus {
  if (REVERSED_EVENT.test(text)) return "reversed";
  if (NEGATED_EVENT.test(text)) return "negated";
  if (PROSPECTIVE_EVENT.test(text)) return "prospective";
  return "asserted";
}

export function supportsRecallScalarValue(shape: RecallAnswerShape, content: string): boolean {
  if (shape === "place") return supportsPlaceValue(content);
  if (shape === "duration") return DURATION_VALUE_CUE.test(content);
  return false;
}

function assessPlaceBinding(
  plan: Readonly<RecallAnswerShapePlan>,
  probes: Readonly<RecallQueryProbes>,
  sentence: string,
  assertionText: string
): Readonly<RecallScalarBindingAssessment> | null {
  const tokens = new Set(splitLexicalTokens(assertionText));
  if (
    resolveRecallTargetStatus(plan.target_terms, tokens) !== "bound" ||
    resolveRecallRelationStatus(plan.relation_terms, tokens) !== "bound"
  ) return null;
  const purchaseQuery = plan.relation_terms.some((term) => PURCHASE_RELATIONS.has(term));
  const tupleBound = purchaseQuery
    ? isBoundPurchasePlace(plan, sentence, assertionText)
    : isBoundEventPlace(plan, assertionText);
  if (!tupleBound) return null;
  return bindingAssessment(probes, sentence, resolveRecallScalarEventStatus(assertionText));
}

function isBoundPurchasePlace(
  plan: Readonly<RecallAnswerShapePlan>,
  sentence: string,
  assertionText: string
): boolean {
  const from = firstValidPlaceMatch(assertionText, PLACE_VALUE_CUES[0]);
  if (from === null) return false;
  const target = firstTargetIndex(assertionText, plan.target_terms);
  if (target < 0 || target >= from.index) return false;
  const originCopula = /\b(?:is|was|came)\s+from\b/iu.exec(assertionText);
  if (
    originCopula !== null &&
    target < originCopula.index &&
    isClosedSelfOwnedOrigin(plan, sentence)
  ) return resolveRecallScalarEventStatus(sentence) === "asserted";
  const purchase = DIRECT_SELF_PURCHASE.exec(assertionText);
  if (purchase === null) return false;
  const verbOffset = purchase[0].lastIndexOf(purchase.groups?.verb ?? "");
  const purchaseIndex = purchase.index + Math.max(0, verbOffset);
  if (purchaseIndex >= target || target >= from.index) return false;
  const verb = purchase.groups?.verb ?? "";
  return !PURCHASE_GAP_CONFLICT.test(assertionText.slice(target, from.index)) &&
    isClosedDirectPurchaseClause(
      plan,
      assertionText,
      purchaseIndex + verb.length,
      from.index
    );
}

function isClosedDirectPurchaseClause(
  plan: Readonly<RecallAnswerShapePlan>,
  assertionText: string,
  afterVerbIndex: number,
  fromIndex: number
): boolean {
  const allowed = new Set([...plan.target_terms, ...PURCHASE_TARGET_CLAUSE_TERMS]);
  const targetClause = splitLexicalTokens(
    assertionText.slice(afterVerbIndex, fromIndex)
  );
  return targetClause.length > 0 &&
    targetClause.every((term) => allowed.has(term)) &&
    DIRECT_PURCHASE_PLACE_TAIL.test(assertionText.slice(fromIndex));
}

function isClosedSelfOwnedOrigin(
  plan: Readonly<RecallAnswerShapePlan>,
  sentence: string,
): boolean {
  if (countValidPlaceMatches(sentence) !== 1) return false;
  const targetIndex = firstTargetIndex(sentence, plan.target_terms);
  const origin = /\b(?:is|was|came)\s+from\b/iu.exec(sentence);
  if (targetIndex < 0 || origin === null || targetIndex >= origin.index) return false;
  const subjectTerms = splitLexicalTokens(sentence.slice(0, origin.index));
  const allowed = new Set([...plan.target_terms, ...ORIGIN_TARGET_PREFIX_TERMS, "my"]);
  if (
    subjectTerms.length === 0 ||
    !subjectTerms.every((term) => allowed.has(term)) ||
    !ORIGIN_PLACE_TAIL.test(sentence.slice(origin.index))
  ) return false;
  return hasDirectSelfPossessiveTarget(sentence, targetIndex) ||
    /,\s*(?:and\s+)?i(?:['’]m|\s+am)\b/iu.test(sentence.slice(origin.index));
}

function hasDirectSelfPossessiveTarget(
  assertionText: string,
  targetIndex: number
): boolean {
  const prefix = assertionText.slice(0, targetIndex);
  const possessives = [...prefix.matchAll(/\bmy\b/giu)];
  const possessive = possessives.at(-1);
  if (possessive?.index === undefined) return false;
  const gap = prefix.slice(possessive.index + possessive[0].length).trim();
  if (gap.length === 0) return true;
  const modifiers = splitLexicalTokens(gap);
  return modifiers.length <= 2 &&
    modifiers.every((modifier) => SELF_OWNED_TARGET_MODIFIERS.has(modifier));
}

function isBoundEventPlace(
  plan: Readonly<RecallAnswerShapePlan>,
  assertionText: string
): boolean {
  if (plan.relation_terms.length === 0) return false;
  const relation = firstRelationIndex(assertionText, plan.relation_terms);
  const target = firstTargetIndex(assertionText, plan.target_terms);
  const place = firstValidPlaceMatch(assertionText);
  if (relation < 0 || target < 0 || place === null) return false;
  return SELF_ACTOR.test(assertionText.slice(0, relation)) &&
    relation < target &&
    target < place.index;
}

function assessDurationBinding(
  plan: Readonly<RecallAnswerShapePlan>,
  probes: Readonly<RecallQueryProbes>,
  sentences: readonly string[],
  anchoredIndex: number,
  assertionText: string
): Readonly<RecallScalarBindingAssessment> | null {
  if (!plan.relation_terms.some((term) => WAIT_RELATION.has(term))) return null;
  if (countDurationValues(assertionText) !== 1) return null;
  const anchoredSentence = sentences[anchoredIndex];
  if (anchoredSentence === undefined) return null;
  const sameSentence = isBoundDurationEvent(plan, anchoredSentence, true)
    ? anchoredSentence
    : null;
  const priorSentence = anchoredIndex > 0 ? sentences[anchoredIndex - 1] : undefined;
  const adjacent = priorSentence !== undefined &&
    isDurationContinuation(assertionText) &&
    countDurationValues(priorSentence) === 0 &&
    isBoundDurationEvent(plan, priorSentence, false)
    ? priorSentence
    : null;
  const bindingSentence = sameSentence ?? adjacent;
  if (bindingSentence === null) return null;
  const eventStatus = combineEventStatus(
    resolveRecallScalarEventStatus(bindingSentence),
    resolveRecallScalarEventStatus(anchoredSentence)
  );
  return bindingAssessment(probes, bindingSentence, eventStatus);
}

function isDurationContinuation(assertionText: string): boolean {
  return DURATION_CONTINUATION.test(assertionText) &&
    LEADING_DURATION_VALUE_CUE.test(assertionText) &&
    !DURATION_OFFSET.test(assertionText);
}

function isBoundDurationEvent(
  plan: Readonly<RecallAnswerShapePlan>,
  sentence: string,
  requiresValue: boolean
): boolean {
  if (!isClosedDurationEvent(plan, sentence, requiresValue)) return false;
  const tokens = new Set(splitLexicalTokens(sentence));
  if (
    resolveRecallTargetStatus(plan.target_terms, tokens) !== "bound" ||
    resolveRecallRelationStatus(plan.relation_terms, tokens) !== "bound" ||
    (requiresValue && countDurationValues(sentence) !== 1)
  ) return false;
  const relation = firstRelationIndex(sentence, plan.relation_terms);
  if (relation < 0) return false;
  const explicitActor = SELF_ACTOR.test(sentence.slice(0, relation));
  const possessiveIndex = sentence.search(/\bmy\b/iu);
  const targetIndex = firstTargetIndex(sentence, plan.target_terms);
  const possessiveTarget = relation < possessiveIndex &&
    possessiveIndex < targetIndex &&
    hasDirectSelfPossessiveTarget(sentence, targetIndex);
  return explicitActor || possessiveTarget;
}

function isClosedDurationEvent(
  plan: Readonly<RecallAnswerShapePlan>,
  sentence: string,
  requiresValue: boolean
): boolean {
  const direct = DIRECT_DURATION_EVENT.exec(sentence);
  if (direct !== null) {
    return bodyUsesOnly(
      direct.groups?.body ?? "",
      plan.target_terms,
      DURATION_DIRECT_BODY_TERMS
    );
  }
  const context = requiresValue
    ? null
    : POSSESSIVE_DURATION_CONTEXT.exec(sentence) ??
      POSSESSIVE_DURATION_TAKEN_CONTEXT.exec(sentence);
  return context !== null &&
    bodyUsesOnly(
      context.groups?.body ?? "",
      plan.target_terms,
      DURATION_CONTEXT_BODY_TERMS
    ) &&
    [...DURATION_CONTEXT_STATUS_TERMS].some((term) =>
      new RegExp(`\\b${term}\\b`, "iu").test(context.groups?.body ?? "")
    );
}

function bodyUsesOnly(
  body: string,
  targetTerms: readonly string[],
  grammarTerms: ReadonlySet<string>
): boolean {
  const allowed = new Set([...targetTerms, ...grammarTerms]);
  const tokens = splitLexicalTokens(body);
  return tokens.length > 0 && tokens.every((token) => allowed.has(token));
}

function bindingAssessment(
  probes: Readonly<RecallQueryProbes>,
  sentence: string,
  eventStatus = resolveRecallScalarEventStatus(sentence)
): Readonly<RecallScalarBindingAssessment> {
  return Object.freeze({
    unique: true,
    subject_status: "bound",
    target_status: "bound",
    relation_status: "bound",
    event_status: eventStatus,
    time_status: probes.date_terms.length === 0 ? "not_requested" : "unknown"
  });
}

function combineEventStatus(
  left: RecallScalarEventStatus,
  right: RecallScalarEventStatus
): RecallScalarEventStatus {
  const priority: readonly RecallScalarEventStatus[] =
    ["reversed", "negated", "prospective", "asserted"];
  return priority.find((status) => left === status || right === status) ?? "asserted";
}

function firstRelationIndex(text: string, relationTerms: readonly string[]): number {
  const aliases = relationTerms.flatMap((term) => {
    const family = RELATION_ALIASES.find((candidate) => candidate.has(term));
    return family === undefined ? [term] : [...family].filter((alias) => alias !== "from");
  });
  return firstWordIndex(text, aliases);
}

function firstTargetIndex(text: string, targetTerms: readonly string[]): number {
  return firstWordIndex(text, targetTerms);
}

function firstWordIndex(text: string, terms: readonly string[]): number {
  const indices = terms
    .map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "iu").exec(text)?.index ?? -1)
    .filter((index) => index >= 0);
  return indices.length === 0 ? -1 : Math.min(...indices);
}

function firstValidPlaceMatch(
  text: string,
  onlyPattern?: RegExp
): Readonly<{ readonly index: number; readonly value: string }> | null {
  const patterns = onlyPattern === undefined ? PLACE_VALUE_CUES : [onlyPattern];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match.groups?.value?.toLowerCase() ?? "";
      if (isValidPlaceValue(value)) return { index: match.index, value };
    }
  }
  return null;
}

function supportsPlaceValue(content: string): boolean {
  return firstValidPlaceMatch(content) !== null;
}

function countValidPlaceMatches(text: string): number {
  let count = 0;
  for (const pattern of PLACE_VALUE_CUES) {
    for (const match of text.matchAll(pattern)) {
      if (isValidPlaceValue(match.groups?.value?.toLowerCase() ?? "")) count += 1;
    }
  }
  return count;
}

function isValidPlaceValue(value: string): boolean {
  return value.length > 0 &&
    !NON_PLACE_VALUES.has(value) &&
    !value.endsWith("%") &&
    !/^\d+$/u.test(value);
}

function countDurationValues(text: string): number {
  return [...text.matchAll(new RegExp(DURATION_VALUE_SOURCE, "giu"))].length;
}

function splitAssertionSentences(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
