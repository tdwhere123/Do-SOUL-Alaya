import { BE_AUXILIARIES } from "./clause-boundaries.js";
import {
  CJK_COPULAR_MEASURE_FORMS,
  CJK_COPULAR_PREDICATE_FORMS,
  CJK_LOCATION_RESULT_FORMS
} from "./cjk-interrogative-forms.js";
import { tokenizeFactFrameSource } from "./source-text.js";

export const COPULAR_MEASURE_WORDS: ReadonlySet<string> = new Set(["long"]);
const CJK_COPULAR_MEASURE_FORM_SET: ReadonlySet<string> =
  new Set(CJK_COPULAR_MEASURE_FORMS);
const CJK_LOCATION_RESULT_FORM_SET: ReadonlySet<string> =
  new Set(CJK_LOCATION_RESULT_FORMS);
const CJK_COPULAR_PREDICATE_SET: ReadonlySet<string> =
  new Set(CJK_COPULAR_PREDICATE_FORMS);
const CJK_GENERIC_SPEAKERS: ReadonlySet<string> = new Set(["我", "我们"]);
const ENGLISH_GENERIC_SPEAKERS: ReadonlySet<string> = new Set([
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours"
]);

export function isRuleBasedCopularMeasureValue(surface: string): boolean {
  const tokens = tokenizeFactFrameSource(surface);
  if (tokens.length === 2 && tokens[0]!.normalized === "how" &&
      COPULAR_MEASURE_WORDS.has(tokens[1]!.normalized)) {
    return true;
  }
  return CJK_COPULAR_MEASURE_FORM_SET.has(joinedNormalized(tokens));
}

export function isRuleBasedLocationResultValue(surface: string): boolean {
  const tokens = tokenizeFactFrameSource(surface);
  return (tokens.length === 1 && tokens[0]!.normalized === "where") ||
    CJK_LOCATION_RESULT_FORM_SET.has(joinedNormalized(tokens));
}

export function isRuleBasedCopularPredicate(surface: string): boolean {
  const tokens = tokenizeFactFrameSource(surface);
  if (tokens.length !== 1) return false;
  const normalized = tokens[0]!.normalized;
  return BE_AUXILIARIES.has(normalized) || CJK_COPULAR_PREDICATE_SET.has(normalized);
}

export function isRuleBasedGenericSpeaker(surface: string): boolean {
  const tokens = tokenizeFactFrameSource(surface);
  if (tokens.length !== 1) return false;
  const normalized = tokens[0]!.normalized;
  return ENGLISH_GENERIC_SPEAKERS.has(normalized) || CJK_GENERIC_SPEAKERS.has(normalized);
}

export function isCjkCopularMeasureTokens(
  tokens: readonly { readonly normalized: string }[]
): boolean {
  return CJK_COPULAR_MEASURE_FORM_SET.has(joinedNormalized(tokens));
}

export function isCjkLocationResultToken(normalized: string): boolean {
  return CJK_LOCATION_RESULT_FORM_SET.has(normalized);
}

function joinedNormalized(
  tokens: readonly { readonly normalized: string }[]
): string {
  return tokens.map((token) => token.normalized).join("");
}
