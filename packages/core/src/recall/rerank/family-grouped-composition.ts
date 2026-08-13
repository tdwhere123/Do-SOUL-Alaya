import { clamp01 } from "../../shared/clamp.js";

export const FAMILY_GROUPED_COMPOSITION_OPERATOR_ID =
  "family_grouped_composition_v2" as const;

export const LEGACY_FAMILY_GROUPED_COMPOSITION_OPERATOR_ID =
  "family_grouped_composition_v1" as const;

export type FamilyGroupedScores = Readonly<{
  readonly lexical_evidence: number;
  readonly semantic: number | null;
  readonly fusion: number | null;
}>;

export type FamilyGroupedComposition = Readonly<{
  readonly operatorId:
    | typeof FAMILY_GROUPED_COMPOSITION_OPERATOR_ID
    | typeof LEGACY_FAMILY_GROUPED_COMPOSITION_OPERATOR_ID;
  readonly familyScores: FamilyGroupedScores;
  readonly resolvedScore: number;
}>;

type FamilyGroupedCompositionInput = Readonly<{
  readonly lexicalEvidence: number;
  readonly semantic: number | null;
  readonly fusion: number | null;
}>;

// Independent lexical and embedding mix additively; fusion already bundles
// correlated lexical/embedding RRF children, so the outer max gives each
// underlying signal at most one vote on every path.
export function composeFamilyGroupedScore(
  input: FamilyGroupedCompositionInput
): FamilyGroupedComposition {
  const familyScores = freezeFamilyScores(input);
  const independentMix = boundedIndependentMix(
    familyScores.lexical_evidence,
    familyScores.semantic
  );
  return Object.freeze({
    operatorId: FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
    familyScores,
    resolvedScore: maxObserved(independentMix, familyScores.fusion)
  });
}

/** Dual-read for pre-v2 traces; v1 never reached a persisted boundary artifact. */
export function composeLegacyFamilyGroupedScoreV1(
  input: FamilyGroupedCompositionInput
): FamilyGroupedComposition {
  const familyScores = freezeFamilyScores(input);
  const lexicalField = maxObserved(
    familyScores.lexical_evidence,
    familyScores.fusion
  );
  const mixed = familyScores.semantic === null
    ? lexicalField
    : lexicalField + familyScores.semantic;
  return Object.freeze({
    operatorId: LEGACY_FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
    familyScores,
    resolvedScore: clamp01(mixed)
  });
}

export function composeFamilyGroupedScoreByOperatorId(
  operatorId: string | undefined,
  input: FamilyGroupedCompositionInput
): FamilyGroupedComposition {
  if (operatorId === LEGACY_FAMILY_GROUPED_COMPOSITION_OPERATOR_ID) {
    return composeLegacyFamilyGroupedScoreV1(input);
  }
  return composeFamilyGroupedScore(input);
}

function freezeFamilyScores(
  input: FamilyGroupedCompositionInput
): FamilyGroupedScores {
  return Object.freeze({
    lexical_evidence: clamp01(input.lexicalEvidence),
    semantic: input.semantic === null ? null : clamp01(input.semantic),
    fusion: input.fusion === null ? null : clamp01(input.fusion)
  });
}

function boundedIndependentMix(
  lexicalEvidence: number,
  semantic: number | null
): number {
  if (semantic === null) return lexicalEvidence;
  return clamp01(lexicalEvidence + semantic);
}

function maxObserved(left: number, right: number | null): number {
  return right === null ? left : Math.max(left, right);
}
