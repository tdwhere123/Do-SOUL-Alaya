import {
  EvidenceFactFrameFormationProposalSchema,
  ASSOCIATIVE_FACT_FRAME_SLOT_LIMIT,
  type AssociativeFactFrame,
  type AssociativeFactSlot,
  type EvidenceFactFrameFormationProposal
} from "@do-soul/alaya-protocol";
import { skipLeadingAdjunctSpan } from
  "../../shared/fact-frame-grammar/leading-adjunct.js";
import {
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  type FactFrameSourceToken
} from "../../shared/fact-frame-grammar/source-text.js";

export const RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID =
  "rule_based_evidence_fact_frame_normalizer_v2";

export interface EvidenceFactFrameProposalNormalizer {
  readonly operator_id: string;
  propose(sourceAssertion: string): Readonly<EvidenceFactFrameFormationProposal> | undefined;
}

type SubjectSpan = Readonly<{
  readonly text: string;
  readonly nextIndex: number;
  readonly modalQualifier?: FactFrameSourceToken;
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
    if (subject === null) return undefined;
    const predicate = readPredicate(tokens, subject.nextIndex, subject.modalQualifier);
    if (!predicate.supported) return undefined;
    const relation = tokens[predicate.relationIndex];
    const valueStart = predicate.relationIndex + 1;
    if (relation === undefined || valueStart >= tokens.length ||
        !isRelationToken(tokens, predicate.relationIndex)) return undefined;
    if (valueStartsFiniteClause(tokens, valueStart) ||
        valueContainsDelimitedClause(assertion, tokens, valueStart)) {
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
          slot("subject", subject.text),
          ...predicate.qualifiers.map((token) => slot("qualifier", token.text)),
          slot("relation", relation.text),
          slot("value", value)
        ]
      }
    });
  }
}

function valueStartsFiniteClause(
  tokens: readonly FactFrameSourceToken[],
  valueStart: number
): boolean {
  return AUXILIARIES.has(tokens[valueStart]?.normalized ?? "");
}

function valueContainsDelimitedClause(
  source: string,
  tokens: readonly FactFrameSourceToken[],
  valueStart: number
): boolean {
  for (let index = valueStart + 1; index < tokens.length; index += 1) {
    const subject = readSubject(source, tokens, index);
    if (subject === null || !readPredicate(tokens, subject.nextIndex, subject.modalQualifier).supported) continue;
    const previous = tokens[index - 1];
    if (previous !== undefined && /[,;:!?]/u.test(
      source.slice(previous.end, tokens[index]!.start)
    )) return true;
  }
  return false;
}

export const RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER:
Readonly<EvidenceFactFrameProposalNormalizer> = Object.freeze(
  new RuleBasedEvidenceFactFrameNormalizer()
);

/** Explicit proposals and retained captures cannot omit supported source modality. */
export function factFramePreservesSourceModality(source: string, frame: Readonly<AssociativeFactFrame>): boolean {
  const assertion = source.trim();
  const tokens = tokenizeFactFrameSource(assertion);
  const subject = readInitialSubject(assertion, tokens);
  if (subject === null) {
    return !tokens.some((token) => isModalQualifier(token) ||
      /^(?:i|you|he|she|it|we|they)['\u2019](?:d|ll)$/u.test(token.normalized));
  }
  const predicate = readPredicate(tokens, subject.nextIndex, subject.modalQualifier);
  if (!predicate.qualifiers.some(isModalQualifier)) return true;
  const canonical = RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER.propose(assertion);
  if (canonical === undefined) return false;
  const qualifiers = (value: Readonly<AssociativeFactFrame>) =>
    value.slots.filter((slot) => slot.role === "qualifier").map((slot) => slot.text);
  const actual = qualifiers(frame);
  let cursor = 0;
  return qualifiers(canonical.fact_frame).every((required) => {
    const index = actual.indexOf(required, cursor);
    if (index < 0) return false;
    cursor = index + 1;
    return true;
  });
}

function readInitialSubject(source: string, tokens: readonly FactFrameSourceToken[]): SubjectSpan | null {
  return readSubject(source, tokens, skipLeadingAdjunctSpan(tokens,
    (index) => readSubject(source, tokens, index) !== null));
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
    if (isModalQualifier(token) || NEGATIVE_AUXILIARY_PATTERN.test(token.normalized)) {
      qualifiers.push(token);
    } else if (AUXILIARIES.has(token.normalized) &&
        !isLexicalAuxiliaryRelation(tokens, index)) {
      if (HAVE_FORMS.has(token.normalized) && !hasPerfectComplement(tokens, index + 1)) {
        return Object.freeze({ qualifiers: Object.freeze(qualifiers), relationIndex: index, supported: false });
      }
      index += 1;
      continue;
    } else if (PRE_RELATION_QUALIFIERS.has(token.normalized)) {
      qualifiers.push(token);
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
