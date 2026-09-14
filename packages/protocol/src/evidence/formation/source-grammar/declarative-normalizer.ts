import {
  EvidenceFactFrameFormationProposalSchema,
  ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT,
  groundAssociativeFactFrameSlots,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type EvidenceFactFrameFormationProposal
} from "../../associative-fact-frame.js";
import { hasUnquotedSourceDependentScope, isInsideSourceQuotation } from "../../source-dependent-scope.js";
import { BE_AUXILIARIES } from "./clause-boundaries.js";
import { skipLeadingAdjunctSpan } from
  "./leading-adjunct.js";
import {
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  type FactFrameSourceToken
} from "./source-text.js";

export const RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID =
  "rule_based_evidence_fact_frame_normalizer_v4";

export interface EvidenceFactFrameProposalNormalizer {
  readonly operator_id: string;
  propose(sourceAssertion: string): Readonly<EvidenceFactFrameFormationProposal> | undefined;
}

type SubjectSpan = Readonly<{
  readonly text: string;
  readonly nextIndex: number;
  readonly modalQualifier?: FactFrameSourceToken;
  readonly prefix?: string;
}>;

export class RuleBasedEvidenceFactFrameNormalizer
implements EvidenceFactFrameProposalNormalizer {
  public readonly operator_id =
    RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID;

  public propose(
    sourceAssertion: string
  ): Readonly<EvidenceFactFrameFormationProposal> | undefined {
    const assertion = sourceAssertion.trim();
    const tokens = tokenizeFactFrameSource(assertion);
    const subject = readInitialSubject(assertion, tokens);
    if (subject == null) return undefined;
    const predicate = readPredicate(tokens, subject.nextIndex, subject.modalQualifier);
    if (!predicate.supported || 3 + predicate.qualifiers.length + (subject.prefix === undefined ? 0 : 1) >
        ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT) return undefined;
    const relation = tokens[predicate.relationIndex];
    const valueStart = predicate.relationIndex + 1;
    if (relation === undefined || valueStart >= tokens.length ||
        !isRelationToken(tokens, predicate.relationIndex)) return undefined;
    if (valueCrossesUnsupportedScope(assertion, tokens, valueStart)) {
      return undefined;
    }
    const value = sliceFactFrameTokens(assertion, tokens, valueStart, tokens.length);
    if (value.length === 0 || value.length > MAX_SLOT_TEXT_LENGTH) return undefined;
    return EvidenceFactFrameFormationProposalSchema.parse({
      schema_version: 1,
      producer_operator_id: this.operator_id,
      source_assertion: assertion,
      fact_frame: {
        schema_version: 1,
        slots: [
          ...(subject.prefix === undefined ? [] : [slot("qualifier", subject.prefix)]),
          slot("subject", subject.text),
          ...predicate.qualifiers.map((token) => slot("qualifier", token.text)),
          slot("relation", relation.text),
          slot("value", value)
        ]
      }
    });
  }
}

function valueCrossesUnsupportedScope(
  source: string,
  tokens: readonly FactFrameSourceToken[],
  valueStart: number
): boolean {
  // An opaque value cannot certify the scope of a dependent condition.
  if (hasUnquotedSourceDependentScope(source, tokens[valueStart]?.start ?? source.length)) return true;
  if (AUXILIARIES.has(tokens[valueStart]?.normalized ?? "")) return true;
  for (let index = valueStart + 1; index < tokens.length; index += 1) {
    if (isInsideSourceQuotation(source, tokens[index]!.start)) continue;
    const subject = readSubject(source, tokens, index);
    if (subject === null) continue;
    const predicate = readPredicate(tokens, subject.nextIndex, subject.modalQualifier);
    const explicitFiniteHead = predicate.qualifiers.length > 0 ||
      AUXILIARIES.has(tokens[subject.nextIndex]?.normalized ?? "");
    if (!explicitFiniteHead && !isRelationToken(tokens, predicate.relationIndex)) continue;
    const previous = tokens[index - 1];
    // "The user account" can be a coordinated object; an explicit predicate head
    // such as "the user cannot ..." instead proves the supported finite clause.
    const finiteSubject = subject.nextIndex === index + 1 || explicitFiniteHead;
    const coordinatedClause = finiteSubject &&
      (previous?.normalized === "and" || previous?.normalized === "but");
    if (previous !== undefined && (coordinatedClause || /[,;:!?]/u.test(
      source.slice(previous.end, tokens[index]!.start)
    ))) return true;
  }
  return false;
}

export const RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER:
Readonly<EvidenceFactFrameProposalNormalizer> = Object.freeze(
  new RuleBasedEvidenceFactFrameNormalizer()
);

/** All formation paths retain the obligations recognized by the source grammar. */
export function factFramePreservesSourceObligations(source: string, frame: Readonly<AssociativeFactFrame>): boolean {
  const assertion = source.trim();
  const tokens = tokenizeFactFrameSource(assertion);
  const grounded = groundAssociativeFactFrameSlots(frame, assertion);
  const relations = grounded?.filter(({ role }) => role === "relation");
  if (grounded === null || relations?.length !== 1) return false;
  const located = readInitialSubject(assertion, tokens);
  const subject = located === null ? readNamedSubjectAnchor(tokens) : located;
  if (subject == null || frame.slots.filter((slot) => slot.role === "subject").length !== 1 ||
      frame.slots.find((slot) => slot.role === "subject")?.text !== subject.text) return false;
  const predicate = readPredicate(tokens, subject.nextIndex, subject.modalQualifier);
  if (!predicate.supported) return false;
  const lexical = tokens[predicate.relationIndex];
  // Explicit copulas may retain the source's first auxiliary. Both anchors come
  // from the source grammar, never a proposed slot's chosen endpoint.
  let headIndex = subject.nextIndex;
  while (tokens[headIndex] !== undefined && isPredicateQualifier(tokens[headIndex]!)) headIndex += 1;
  const head = tokens[headIndex];
  const relation = relations[0]!;
  const sourceRelation = lexical?.start === relation.source_span[0] && isRelationToken(tokens, predicate.relationIndex)
    ? lexical : head !== undefined && BE_AUXILIARIES.has(head.normalized) && head.start === relation.source_span[0]
      ? head : undefined;
  if (sourceRelation === undefined || sourceRelation.end > relation.source_span[1]) return false;
  // Grounding proves presence; completeness also requires every source token
  // after the predicate to survive in an ordered slot. Punctuation is not a token.
  if (tokens.some((token) => token.start >= sourceRelation.start && !grounded.some(({ source_span: [start, end] }) =>
    start <= token.start && token.end <= end))) return false;
  if (valueCrossesUnsupportedScope(assertion, tokens, tokens.indexOf(sourceRelation) + 1)) return false;
  if (predicate.qualifiers.length > MAX_QUALIFIERS) return false;
  const required = [...(subject.prefix === undefined ? [] : [subject.prefix]),
    ...predicate.qualifiers.map((token) => token.text)];
  const actual = frame.slots.filter((slot) => slot.role === "qualifier").map((slot) => slot.text);
  let cursor = 0;
  return required.every((qualifier) => {
    const index = actual.indexOf(qualifier, cursor);
    if (index < 0) return false;
    cursor = index + 1;
    return true;
  });
}

/** The bounded explicit NP anchor is one source-start capitalized name token. */
function readNamedSubjectAnchor(tokens: readonly FactFrameSourceToken[]): SubjectSpan | undefined {
  const first = tokens[0];
  if (first?.start !== 0 || !/^\p{Lu}\p{L}*$/u.test(first.text) ||
      AUXILIARIES.has(first.normalized) || RELATION_STOP_WORDS.has(first.normalized) ||
      isPredicateQualifier(first)) return undefined;
  return { text: first.text, nextIndex: 1 };
}

/** null: unrecognized subject; undefined: located subject crosses an unsupported boundary. */
function readInitialSubject(source: string, tokens: readonly FactFrameSourceToken[]): SubjectSpan | null | undefined {
  // An unclosed quotation cannot hide the rest of the source from clause checks.
  if (isInsideSourceQuotation(source, source.length)) return undefined;
  const start = skipLeadingAdjunctSpan(tokens, (index) => readSubject(source, tokens, index) !== null);
  const subject = readSubject(source, tokens, start);
  if (subject === null) return null;
  if (isInsideSourceQuotation(source, tokens[start]!.start)) return undefined;
  const prefix = source.slice(0, tokens[start]!.start).trim();
  if (prefix.length > MAX_SLOT_TEXT_LENGTH) return undefined;
  return { ...subject, ...(prefix.length === 0 ? {} : { prefix }) };
}

function readSubject(
  source: string,
  tokens: readonly FactFrameSourceToken[],
  start: number
): SubjectSpan | null {
  const first = tokens[start];
  if (first === undefined) return null;
  const contraction = contractedPronounSubject(first, start);
  if (contraction !== null) return contraction;
  if (SUBJECT_PRONOUNS.has(first.normalized)) {
    return Object.freeze({ text: first.text, nextIndex: start + 1 });
  }
  if (first.normalized === "the" && tokens[start + 1]?.normalized === "user") {
    return Object.freeze({
      text: sliceFactFrameTokens(source, tokens, start, start + 2),
      nextIndex: start + 2
    });
  }
  return null;
}

function contractedPronounSubject(
  token: FactFrameSourceToken,
  start: number
): SubjectSpan | null {
  const apostropheIndex = token.text.search(/['\u2019]/u);
  if (apostropheIndex <= 0) return null;
  const subject = token.text.slice(0, apostropheIndex);
  const suffix = token.normalized.slice(apostropheIndex + 1);
  return SUBJECT_PRONOUNS.has(subject.toLowerCase()) &&
    SUBJECT_AUXILIARY_CONTRACTIONS.has(suffix)
    ? Object.freeze({ text: subject, nextIndex: start + 1,
      ...(suffix === "ll" ? { modalQualifier: Object.freeze({
        text: token.text.slice(apostropheIndex), normalized: token.normalized.slice(apostropheIndex),
        start: token.start + apostropheIndex, end: token.end
      }) } : {}) })
    : null;
}

function readPredicate(
  tokens: readonly FactFrameSourceToken[],
  start: number,
  contractedModal?: FactFrameSourceToken
): Readonly<{
  readonly qualifiers: readonly FactFrameSourceToken[];
  readonly relationIndex: number;
  readonly supported: boolean;
}> {
  const qualifiers: FactFrameSourceToken[] = contractedModal === undefined ? [] : [contractedModal];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (isPredicateQualifier(token)) {
      qualifiers.push(token);
    } else if (AUXILIARIES.has(token.normalized) &&
        !isLexicalAuxiliaryRelation(tokens, index)) {
      if (HAVE_FORMS.has(token.normalized) && !hasPerfectComplement(tokens, index + 1)) {
        return Object.freeze({ qualifiers: Object.freeze(qualifiers), relationIndex: index, supported: false });
      }
      index += 1;
      continue;
    } else {
      break;
    }
    index += 1;
  }
  return Object.freeze({ qualifiers: Object.freeze(qualifiers), relationIndex: index,
    supported: qualifiers.length <= MAX_QUALIFIERS });
}

function isModalQualifier(token: FactFrameSourceToken): boolean {
  return MODALS.has(token.normalized) || NEGATIVE_MODAL_PATTERN.test(token.normalized) ||
    /^['\u2019]ll$/u.test(token.normalized);
}

function isPredicateQualifier(token: FactFrameSourceToken): boolean {
  return isModalQualifier(token) || NEGATIVE_AUXILIARY_PATTERN.test(token.normalized) ||
    PRE_RELATION_QUALIFIERS.has(token.normalized);
}

function isRelationToken(
  tokens: readonly FactFrameSourceToken[],
  index: number
): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  return /^\p{L}/u.test(token.text) &&
    (!AUXILIARIES.has(token.normalized) ||
      isLexicalAuxiliaryRelation(tokens, index)) &&
    !RELATION_STOP_WORDS.has(token.normalized);
}

function isLexicalAuxiliaryRelation(
  tokens: readonly FactFrameSourceToken[],
  index: number
): boolean {
  const token = tokens[index];
  if (token === undefined || !LEXICAL_AUXILIARY_RELATIONS.has(token.normalized)) {
    return false;
  }
  const valueLead = tokens[index + 1];
  if (valueLead === undefined) return false;
  if (HAVE_FORMS.has(token.normalized) && hasPerfectComplement(tokens, index + 1)) return false;
  if (VALUE_LEADING_WORDS.has(valueLead.normalized) ||
      /^\p{Lu}/u.test(valueLead.text) || /^[#@]/u.test(valueLead.text)) {
    return true;
  }
  return index + 2 === tokens.length &&
    !PRE_RELATION_QUALIFIERS.has(valueLead.normalized) &&
    !AUXILIARIES.has(valueLead.normalized);
}

function slot(
  role: AssociativeFactSlot["role"],
  text: string
): Readonly<AssociativeFactSlot> {
  return Object.freeze({ role, text });
}

const MAX_SLOT_TEXT_LENGTH = 512;
const MAX_QUALIFIERS = Math.min(2, ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT - 3);
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set([
  "i", "you", "he", "she", "it", "we", "they"
]);
const SUBJECT_AUXILIARY_CONTRACTIONS: ReadonlySet<string> = new Set([
  "ll", "m", "re", "ve"
]);
const MODALS: ReadonlySet<string> = new Set([
  "can", "cannot", "could", "may", "might", "must", "shall", "should", "will", "would"
]);
const AUXILIARIES: ReadonlySet<string> = new Set([
  ...MODALS, "am", "are", "be", "been", "being", "did", "do",
  "does", "had", "has", "have", "is", "was", "were"
]);
const LEXICAL_AUXILIARY_RELATIONS: ReadonlySet<string> = new Set([
  "do", "had", "has", "have"
]);
const HAVE_FORMS: ReadonlySet<string> = new Set(["had", "has", "have"]);
const VALUE_LEADING_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "my", "your", "his", "her", "its", "our", "their",
  "this", "that", "these", "those", "some", "any", "one", "two",
  "more", "less", "fewer", "many", "much", "several", "enough", "no", "both", "each", "every"
]);
function hasPerfectComplement(tokens: readonly FactFrameSourceToken[], start: number): boolean {
  let index = start;
  while (PRE_RELATION_QUALIFIERS.has(tokens[index]?.normalized ?? "")) index += 1;
  const word = tokens[index]?.normalized ?? "";
  return /^(?:[a-z]{3,}ed|been|had|done|gone|seen|known|taken|given|made|bought|brought|found|left|lost|read|sent|spent|told|written|won|heard|held|kept|felt|met|paid|put|run|built|caught|chosen|driven|eaten|fallen|forgotten|grown|learned|said|sold|shown|spoken|thought|understood|worn)$/u.test(word);
}
const PRE_RELATION_QUALIFIERS: ReadonlySet<string> = new Set([
  "already", "also", "always", "currently", "ever", "just", "never",
  "not", "originally", "personally", "really", "recently", "still",
  "then", "usually", "yet"
]);
const RELATION_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "but", "for", "from", "in", "of", "on", "or",
  "the", "to", "with"
]);
const NEGATIVE_MODAL_PATTERN = /^(?:ca|could|may|might|must|sha|should|wo|would)n['\u2019]t$/u;
const NEGATIVE_AUXILIARY_PATTERN = /n['\u2019]t$/u;
