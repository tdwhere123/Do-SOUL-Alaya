export interface HeuristicPreferenceProfile {
  readonly preference_subject: string;
  readonly preference_predicate: string;
  readonly preference_object: string;
  readonly preference_category?: string;
  readonly preference_polarity: "positive" | "negative" | "neutral";
  readonly projection_schema_version: 1;
}

const PREFERENCE_CUE =
  /^(?:i\s+(?:always\s+use|prefer)|my\s+preference\s+is|never\s+use|我(?:总是用|偏好|更喜欢)|我的偏好是|不要用|从不用)/iu;
const NEGATIVE_CUE = /^(?:never\s+use|avoid|do\s+not\s+use|don't\s+use|不要用|从不用)/iu;

export function buildHeuristicPreferenceProfile(
  matchedText: string,
  patternCategory: "preference" | "decision" | "constraint"
): HeuristicPreferenceProfile | null {
  if (patternCategory !== "preference") {
    return null;
  }
  const preferenceObject = extractPreferenceObject(matchedText);
  if (preferenceObject.length === 0) {
    return null;
  }
  const polarity = NEGATIVE_CUE.test(matchedText) ? "negative" : "positive";
  return {
    preference_subject: "operator",
    preference_predicate: polarity === "negative" ? "avoid" : "prefer",
    preference_object: preferenceObject,
    ...derivePreferenceCategory(preferenceObject),
    preference_polarity: polarity,
    projection_schema_version: 1
  };
}

function extractPreferenceObject(matchedText: string): string {
  return matchedText
    .replace(PREFERENCE_CUE, "")
    .replace(/[.!?。！？]+$/u, "")
    .trim()
    .slice(0, 1024);
}

function derivePreferenceCategory(
  preferenceObject: string
): Pick<HeuristicPreferenceProfile, "preference_category"> | Record<string, never> {
  const category = preferenceObject.split(/\s+/u)[0]?.replace(/[^\p{Letter}\p{Number}_-]/gu, "") ?? "";
  return category.length === 0 ? {} : { preference_category: category.slice(0, 128) };
}
