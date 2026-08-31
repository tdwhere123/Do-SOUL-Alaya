import { stripSourceRoleMarker } from "./source-role/marker.js";

export interface DirectPreferenceRelation {
  readonly predicate: string;
  readonly object: string;
  readonly category?: string;
  readonly polarity?: "positive" | "negative";
}

export function parseDirectPreferenceRelation(
  assertion: string
): DirectPreferenceRelation | undefined {
  const scoped = splitLeadingScopeAdjunct(stripSourceRoleMarker(assertion));
  const normalized = normalizePreferenceGroundingText(scoped.clause);
  const match = /^i\s+(don t dislike|do not dislike|prefer|like|love|enjoy|avoid|dislike|hate)\s+(.+)$/u
    .exec(normalized);
  if (match === null) return undefined;
  const predicate = match[1]!;
  const relation = splitObjectAndCategory(stripTrailingTemporalAdjunct(match[2]!));
  if (relation.object.length === 0) return undefined;
  const category = scoped.category ?? relation.category;
  return {
    predicate,
    object: relation.object,
    ...(category === undefined ? {} : { category }),
    ...relationPolarity(predicate, relation.object)
  };
}

export function normalizePreferenceGroundingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_\p{Dash_Punctuation}\p{Punctuation}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripTrailingTemporalAdjunct(value: string): string {
  return value.replace(/\s+(?:now|currently)$/u, "").trim();
}

function splitLeadingScopeAdjunct(assertion: string): {
  readonly clause: string;
  readonly category?: string;
} {
  const scoped = /^for\s+(?:the\s+)?([^,\r\n]{1,128}),\s*(.+)$/iu
    .exec(assertion.normalize("NFKC").trim());
  if (scoped === null) return { clause: assertion };
  const category = normalizePreferenceGroundingText(scoped[1]!);
  return category.length === 0
    ? { clause: scoped[2]! }
    : { clause: scoped[2]!, category };
}

function splitObjectAndCategory(value: string): {
  readonly object: string;
  readonly category?: string;
} {
  const scoped = /^(.+?)\s+for\s+(?:the\s+)?(.+)$/u.exec(value);
  if (scoped === null) return { object: value };
  return { object: scoped[1]!.trim(), category: scoped[2]!.trim() };
}

function relationPolarity(
  predicate: string,
  object: string
): Pick<DirectPreferenceRelation, "polarity"> | Record<string, never> {
  if (predicate === "don t dislike" || predicate === "do not dislike" ||
      /\b(?:no|not|never)\b/u.test(object)) return {};
  return {
    polarity: predicate === "avoid" || predicate === "dislike" || predicate === "hate"
      ? "negative"
      : "positive"
  };
}
