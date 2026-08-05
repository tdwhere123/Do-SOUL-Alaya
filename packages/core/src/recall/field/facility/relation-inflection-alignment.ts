export const REGULAR_RELATION_INFLECTION_ALIGNMENT_OPERATOR_ID =
  "porter_regular_relation_inflection_v1";
import { containsAlignedTokenSequence } from "./token-sequence-alignment.js";

export function regularRelationInflectionEquivalent(
  fieldValue: string,
  demandValue: string
): boolean {
  const fieldTokens = canonicalTokens(fieldValue);
  const demandTokens = canonicalTokens(demandValue);
  if (demandTokens.length === 0 || demandTokens.length > fieldTokens.length) {
    return false;
  }
  return containsAlignedTokenSequence(fieldTokens, demandTokens, (fieldToken, demandToken) =>
    formsIntersect(regularRelationForms(fieldToken), regularRelationForms(demandToken))
  );
}

function regularRelationForms(token: string): ReadonlySet<string> {
  const forms = new Set([token]);
  if (token.length < 4) return forms;
  addNominalOrThirdPersonForms(token, forms);
  addPastForms(token, forms);
  addContinuousForms(token, forms);
  return forms;
}

function addNominalOrThirdPersonForms(token: string, forms: Set<string>): void {
  if (token.endsWith("ies") && token.length > 4) {
    forms.add(`${token.slice(0, -3)}y`);
  }
  if (/(?:ches|shes|xes|zes|oes)$/u.test(token)) forms.add(token.slice(0, -2));
  if (token.endsWith("s") && !token.endsWith("ss")) forms.add(token.slice(0, -1));
}

function addPastForms(token: string, forms: Set<string>): void {
  if (token.endsWith("ied") && token.length > 4) {
    forms.add(`${token.slice(0, -3)}y`);
    return;
  }
  if (!token.endsWith("ed") || token.length <= 3) return;
  addRegularStemForms(token.slice(0, -2), forms);
}

function addContinuousForms(token: string, forms: Set<string>): void {
  if (!token.endsWith("ing") || token.length <= 5) return;
  addRegularStemForms(token.slice(0, -3), forms);
}

function addRegularStemForms(stem: string, forms: Set<string>): void {
  if (stem.length < 2) return;
  forms.add(stem);
  forms.add(`${stem}e`);
  if (/([^aeiou])\1$/u.test(stem)) forms.add(stem.slice(0, -1));
}

function formsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function canonicalTokens(value: string): readonly string[] {
  return Object.freeze(
    value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}
