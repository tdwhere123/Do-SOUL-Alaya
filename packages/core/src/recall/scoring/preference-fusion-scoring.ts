import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { clamp01 } from "../runtime/recall-service-helpers.js";
import { normalizeEvidenceText } from "./query-evidence-scoring.js";
import { recallProjectionScoringEnabled } from "./temporal-fusion-scoring.js";

export function scorePreferenceProfileAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!recallProjectionScoringEnabled()) {
    return 0;
  }
  if (!isTrustedPreferenceProfileOwner(entry) ||
      !queryProbes.dimensions.includes("preference")) {
    return 0;
  }
  const discriminativeProfileText = normalizeProfileText([
    entry.preference_object,
    entry.preference_category
  ]);
  const overlap = scoreProfileTermOverlap(discriminativeProfileText, queryProbes);
  if (overlap === 0) return 0;
  const polarity = scorePolarityCue(entry.preference_polarity, queryProbes.normalized_query ?? "");
  return clamp01(
    Math.max(overlap, polarity) + (entry.preference_subject === "operator" ? 0.1 : 0)
  );
}

export function scoreSelfReferenceAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (!queryProbes.subject_hints.includes("self_reference")) return 0;
  const content = normalizeEvidenceText(entry.content);
  if (content.length === 0) return 0;
  const explicitSelf = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours)\b|(?:我|我的|我们|咱们|咱)/iu.test(content);
  const userFramed = /\b(?:the user|user|operator|principal)\b/iu.test(content);
  if (!explicitSelf && !userFramed) return 0;
  const genericAssistant = /\b(?:as an ai|i (?:do not|don't) have|i can help|here are|you can|you could|you should|there are many|some suggestions|popular (?:ones|options))\b/iu.test(content);
  const baseScore = explicitSelf ? 1 : 0.55;
  return clamp01(genericAssistant ? baseScore * 0.25 : baseScore);
}

export function isTrustedPreferenceProfileOwner(
  entry: Readonly<MemoryEntry>
): boolean {
  return (entry.source_kind === "user" && entry.formation_kind === "explicit") ||
    (entry.source_kind === "compiler" && entry.formation_kind === "extracted") ||
    (entry.source_kind === "seed" && entry.formation_kind === "explicit");
}

function scoreProfileTermOverlap(
  profileText: string,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  const terms = queryProbes.lexical_terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 3);
  if (terms.length === 0) {
    return 0;
  }
  const hits = terms.filter((term) => containsProfileTerm(profileText, term)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(3, terms.length));
}

function containsProfileTerm(profileText: string, term: string): boolean {
  return /\p{Script=Han}/u.test(term)
    ? profileText.includes(term)
    : ` ${profileText} `.includes(` ${term} `);
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
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_\p{Dash_Punctuation}\p{Punctuation}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
