import type { OfficialApiPreferenceProfileDraft } from "../official-api-signal-parser.js";
import {
  PREFERENCE_SOURCE_ASSERTION_MAX_CHARS,
  resolveSourceAssertion,
  SOURCE_ASSERTION_MAX_CHARS,
  type SourceAssertionResolution
} from "./source-assertion.js";
import {
  buildOfficialApiSourceSpans,
  isDirectQuestionSourceText,
  parseOfficialApiSourceLocator,
  resolveOfficialApiSourceLocatorQuote
} from "./source-locator.js";
import {
  normalizePreferenceGroundingText,
  parseDirectPreferenceRelation,
  type DirectPreferenceRelation
} from "./preference-relation.js";
import { collectSourceRoleMarkers } from "./source-role/marker.js";

const PROFILE_FIELDS = [
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity"
] as const;
const PROFILE_FIELD_MAX_CHARS = 1_024;

export interface PreferenceProfileSourceInput {
  readonly proposal: unknown;
  readonly sourceText?: string;
  readonly sourceCorpus: string;
  readonly proposedMatch: string;
  readonly sourceLocator?: unknown;
}

export interface PreferenceAwareSourceGrounding {
  readonly resolution: SourceAssertionResolution;
  readonly preferenceProfile?: OfficialApiPreferenceProfileDraft;
}

export function resolvePreferenceAwareSourceGrounding(
  input: PreferenceProfileSourceInput
): PreferenceAwareSourceGrounding {
  const standard = resolveOwnedAssertion(input, SOURCE_ASSERTION_MAX_CHARS);
  if (standard.status === "grounded") {
    return withGroundedProfile(input.proposal, standard);
  }
  const extended = resolveOwnedAssertion(input, PREFERENCE_SOURCE_ASSERTION_MAX_CHARS);
  if (extended.status !== "grounded") return { resolution: standard };
  const grounded = withGroundedProfile(input.proposal, extended);
  const relation = parseDirectPreferenceRelation(extended.assertion);
  return relation !== undefined &&
    isCompleteGroundedPreference(grounded.preferenceProfile, relation)
    ? grounded
    : { resolution: standard };
}

export function groundPreferenceProfileFromSource(
  input: PreferenceProfileSourceInput
): OfficialApiPreferenceProfileDraft | undefined {
  return resolvePreferenceAwareSourceGrounding(input).preferenceProfile;
}

export function preferenceProfileGroundingRemovalReason(
  proposal: unknown,
  grounded: unknown
): "unverified_preference_profile_removed" |
  "unverified_preference_profile_fields_removed" | undefined {
  if (proposal === undefined) return undefined;
  if (!isRecord(proposal) || !isRecord(grounded)) {
    return "unverified_preference_profile_removed";
  }
  return PROFILE_FIELDS.some((field) =>
    proposal[field] !== undefined && grounded[field] === undefined
  ) ? "unverified_preference_profile_fields_removed" : undefined;
}

function resolveOwnedAssertion(
  input: PreferenceProfileSourceInput,
  maxChars: number
): SourceAssertionResolution {
  const sourceText = input.sourceText ?? input.sourceCorpus;
  const resolution = input.sourceLocator === undefined
    ? resolveSourceAssertion(sourceText, input.proposedMatch, maxChars)
    : resolveLocatedAssertion(sourceText, input, maxChars);
  if (resolution === undefined) {
    return { status: "rejected", reason: "source_assertion_not_self_contained" };
  }
  if (resolution.status === "rejected") return resolution;
  if (isDirectQuestionSourceText(resolution.assertion)) {
    return { status: "rejected", reason: "source_assertion_incomplete" };
  }
  return hasUniqueUserOwnership(input.sourceCorpus, resolution.assertion)
    ? resolution
    : { status: "rejected", reason: "source_assertion_not_self_contained" };
}

function resolveLocatedAssertion(
  sourceText: string,
  input: PreferenceProfileSourceInput,
  maxChars: number
): SourceAssertionResolution | undefined {
  const locator = parseOfficialApiSourceLocator(input.sourceLocator);
  return locator === null
    ? undefined
    : resolveOfficialApiSourceLocatorQuote(
        sourceText,
        locator,
        input.proposedMatch,
        maxChars
      );
}

function hasUniqueUserOwnership(sourceCorpus: string, assertion: string): boolean {
  if (collectSourceRoleMarkers(sourceCorpus).length === 0) return true;
  const first = sourceCorpus.indexOf(assertion);
  if (first < 0 || sourceCorpus.indexOf(assertion, first + 1) >= 0) return false;
  const containing = buildOfficialApiSourceSpans(sourceCorpus)
    .filter((span) => span.text.includes(assertion));
  return containing.length === 1 && containing[0]?.role === "user";
}

function withGroundedProfile(
  proposal: unknown,
  resolution: Extract<SourceAssertionResolution, { readonly status: "grounded" }>
): PreferenceAwareSourceGrounding {
  const preferenceProfile = groundPreferenceProfileFromAssertion(
    proposal,
    resolution.assertion
  );
  return {
    resolution,
    ...(preferenceProfile === undefined ? {} : { preferenceProfile })
  };
}

function groundPreferenceProfileFromAssertion(
  proposal: unknown,
  assertion: string
): OfficialApiPreferenceProfileDraft | undefined {
  if (!isRecord(proposal)) return undefined;
  const relation = parseDirectPreferenceRelation(assertion);
  if (relation === undefined) return undefined;
  const grounded = groundRelationProposal(proposal, relation);
  if (Object.keys(grounded).length === 0) return undefined;
  return Object.freeze({ projection_schema_version: 1, ...grounded });
}

function isCompleteGroundedPreference(
  grounded: OfficialApiPreferenceProfileDraft | undefined,
  relation: DirectPreferenceRelation
): boolean {
  if (grounded?.preference_subject !== "operator" ||
      grounded.preference_predicate === undefined ||
      grounded.preference_object === undefined) return false;
  if (relation.category !== undefined && grounded.preference_category === undefined) return false;
  return relation.polarity === undefined ||
    grounded.preference_polarity === relation.polarity;
}

function groundRelationProposal(
  proposal: Readonly<Record<string, unknown>>,
  relation: DirectPreferenceRelation
): OfficialApiPreferenceProfileDraft {
  const subject = readProfileText(proposal.preference_subject);
  const predicate = readProfileText(proposal.preference_predicate);
  const object = readProfileText(proposal.preference_object);
  const category = readProfileText(proposal.preference_category);
  if (object?.normalized !== relation.object) return {};
  return {
    ...(subject !== undefined && ["i", "user", "operator"].includes(subject.normalized)
      ? { preference_subject: "operator" }
      : {}),
    ...(predicate?.normalized === relation.predicate
      ? { preference_predicate: predicate.value }
      : {}),
    preference_object: object.value,
    ...(category !== undefined && category.normalized === relation.category
      ? { preference_category: category.value }
      : {}),
    ...(proposal.preference_polarity === relation.polarity
      ? { preference_polarity: relation.polarity }
      : {})
  };
}

function readProfileText(
  value: unknown
): { readonly value: string; readonly normalized: string } | undefined {
  if (typeof value !== "string" || value.length > PROFILE_FIELD_MAX_CHARS) return undefined;
  const normalized = normalizePreferenceGroundingText(value);
  return normalized.length === 0 ? undefined : { value: value.trim(), normalized };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
