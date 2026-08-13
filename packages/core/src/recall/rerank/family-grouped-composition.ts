import { clamp01 } from "../../shared/clamp.js";

export const FAMILY_GROUPED_COMPOSITION_OPERATOR_ID =
  "family_grouped_composition_v1" as const;

export type FamilyGroupedScores = Readonly<{
  readonly lexical_evidence: number;
  readonly semantic: number | null;
  readonly fusion: number | null;
}>;

export type FamilyGroupedComposition = Readonly<{
  readonly operatorId: typeof FAMILY_GROUPED_COMPOSITION_OPERATOR_ID;
  readonly familyScores: FamilyGroupedScores;
  readonly resolvedScore: number;
}>;

type FamilyGroupedCompositionInput = Readonly<{
  readonly lexicalEvidence: number;
  readonly semantic: number | null;
  readonly fusion: number | null;
}>;

// Same-source lexical/fusion views max; independent embedding mixes additively
// under the unit envelope. Fusion's stream children are not extra mix terms.
export function composeFamilyGroupedScore(
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
    operatorId: FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
    familyScores,
    resolvedScore: clamp01(mixed)
  });
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

function maxObserved(lexicalEvidence: number, fusion: number | null): number {
  return fusion === null ? lexicalEvidence : Math.max(lexicalEvidence, fusion);
}
