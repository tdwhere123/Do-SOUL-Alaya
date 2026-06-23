import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { classifyRecallIntent } from "./recall-query-plan.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { clamp01 } from "./recall-service-helpers.js";
import { recallProjectionScoringEnabled } from "./temporal-fusion-scoring.js";

export function scorePreferenceProfileAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!recallProjectionScoringEnabled()) {
    return 0;
  }
  if (entry.dimension !== "preference" || classifyRecallIntent(queryProbes) !== "preference") {
    return 0;
  }
  const profileText = normalizeProfileText([
    entry.preference_subject,
    entry.preference_predicate,
    entry.preference_object,
    entry.preference_category,
    entry.preference_polarity
  ]);
  if (profileText.length === 0) {
    return 0;
  }
  const overlap = scoreProfileTermOverlap(profileText, queryProbes);
  const polarity = scorePolarityCue(entry.preference_polarity, queryProbes.normalized_query ?? "");
  return clamp01(Math.max(overlap, polarity) + (profileText.includes("operator") ? 0.1 : 0));
}

function scoreProfileTermOverlap(
  profileText: string,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  const terms = [...queryProbes.lexical_terms, ...queryProbes.expanded_terms]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return 0;
  }
  const hits = terms.filter((term) => profileText.includes(term)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(3, terms.length));
}

function scorePolarityCue(
  polarity: MemoryEntry["preference_polarity"],
  normalizedQuery: string
): number {
  if (polarity === "negative" && /\b(?:avoid|dislike|never|not|don't|do not)\b|(?:不喜欢|避免|不要)/iu.test(normalizedQuery)) {
    return 0.8;
  }
  if (polarity === "positive" && /\b(?:prefer|like|favorite|favourite)\b|(?:喜欢|偏好)/iu.test(normalizedQuery)) {
    return 0.8;
  }
  return 0;
}

function normalizeProfileText(values: readonly (string | null | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}
