import type {
  OfficialApiPreferenceProfileDraft,
  OfficialApiSignalDraft
} from "../official-api-signal-parser.js";
import {
  filterSourceAssertionEntities,
  resolveSourceAssertion,
  type SourceAssertionRejectionReason
} from "../grounding/source-assertion.js";
import {
  locatorAssertionUniquelyCommitsToQuote,
  resolveOfficialApiSourceLocator
} from "../grounding/source-locator.js";
import type { OfficialApiSourceTrustRejection } from "./source-trust.js";

interface OfficialApiSourceGroundingProposal {
  readonly version: 1;
  readonly proposed_matched_text: string;
  readonly proposed_distilled_fact?: string;
  readonly proposed_canonical_entities?: readonly string[];
  readonly proposed_preference_profile?: OfficialApiPreferenceProfileDraft;
  readonly reasons: readonly string[];
}

export type OfficialApiSourceGroundingAudit = OfficialApiSourceGroundingProposal & (
  | {
      readonly status: "grounded";
      readonly content_basis: "source_assertion";
      readonly source_assertion: string;
    }
  | {
      readonly status: "rejected";
      readonly content_basis: "none";
    }
);

export type OfficialApiGroundingResult =
  | {
      readonly status: "grounded";
      readonly draft: OfficialApiSignalDraft;
      readonly audit: OfficialApiSourceGroundingAudit;
    }
  | { readonly status: "rejected"; readonly draft: OfficialApiSignalDraft; readonly audit: OfficialApiSourceGroundingAudit };

export function groundOfficialApiDraft(
  draft: OfficialApiSignalDraft,
  sourceText: string
): OfficialApiGroundingResult {
  const resolution = draft.source_locator === undefined
    ? resolveSourceAssertion(sourceText, draft.matched_text)
    : resolveOfficialApiSourceLocator(sourceText, draft.source_locator);
  if (resolution.status === "rejected") return rejectedGrounding(draft, resolution.reason);
  const assertion = resolution.assertion;
  if (draft.source_locator !== undefined && !locatorAssertionUniquelyCommitsToQuote(
    sourceText,
    assertion,
    draft.matched_text
  )) {
    return rejectedGrounding(draft, "matched_text_absent");
  }
  const canonicalEntities = groundCanonicalEntities(draft.canonical_entities, assertion);
  const reasons = groundingReasons(draft, assertion, canonicalEntities);
  const {
    matched_text: _matchedText,
    distilled_fact: _distilledFact,
    canonical_entities: _canonicalEntities,
    preference_profile: _preferenceProfile,
    ...rest
  } = draft;
  const groundedDraft: OfficialApiSignalDraft = Object.freeze({
    ...rest,
    matched_text: assertion,
    distilled_fact: assertion,
    ...(canonicalEntities.length === 0 ? {} : { canonical_entities: canonicalEntities })
  });
  return {
    status: "grounded",
    draft: groundedDraft,
    audit: Object.freeze({
      version: 1,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: assertion,
      proposed_matched_text: draft.matched_text,
      ...(draft.distilled_fact === undefined ? {} : { proposed_distilled_fact: draft.distilled_fact }),
      ...(draft.canonical_entities === undefined ? {} : { proposed_canonical_entities: draft.canonical_entities }),
      ...(draft.preference_profile === undefined ? {} : { proposed_preference_profile: draft.preference_profile }),
      reasons: Object.freeze(reasons)
    })
  };
}

export function rejectOfficialApiDraftGrounding(
  draft: OfficialApiSignalDraft,
  reason: SourceAssertionRejectionReason | OfficialApiSourceTrustRejection
): OfficialApiGroundingResult {
  return rejectedGrounding(draft, reason);
}

function rejectedGrounding(
  draft: OfficialApiSignalDraft,
  reason: SourceAssertionRejectionReason | OfficialApiSourceTrustRejection
): OfficialApiGroundingResult {
  const {
    distilled_fact: _distilledFact,
    canonical_entities: _canonicalEntities,
    preference_profile: _preferenceProfile,
    temporal_projection: _temporalProjection,
    ...safeDraft
  } = draft;
  return {
    status: "rejected",
    draft: Object.freeze(safeDraft),
    audit: Object.freeze({
      version: 1,
      status: "rejected",
      content_basis: "none",
      proposed_matched_text: draft.matched_text,
      ...(draft.distilled_fact === undefined ? {} : { proposed_distilled_fact: draft.distilled_fact }),
      ...(draft.canonical_entities === undefined ? {} : { proposed_canonical_entities: draft.canonical_entities }),
      ...(draft.preference_profile === undefined ? {} : { proposed_preference_profile: draft.preference_profile }),
      reasons: Object.freeze([reason])
    })
  };
}

function groundingReasons(
  draft: OfficialApiSignalDraft,
  assertion: string,
  canonicalEntities: readonly string[]
): readonly string[] {
  const reasons: string[] = [];
  if (draft.matched_text.trim() !== assertion) reasons.push("matched_text_expanded_to_source_assertion");
  if (draft.distilled_fact !== undefined && !assertion.includes(draft.distilled_fact.trim())) {
    reasons.push("proposed_distilled_fact_not_verbatim");
  }
  if ((draft.canonical_entities?.length ?? 0) !== canonicalEntities.length) {
    reasons.push("unverified_canonical_entities_removed");
  }
  if (draft.preference_profile !== undefined) reasons.push("unverified_preference_profile_removed");
  return reasons;
}

function groundCanonicalEntities(
  entities: readonly string[] | undefined,
  assertion: string
): readonly string[] {
  if (entities === undefined) return [];
  return filterSourceAssertionEntities(entities, assertion);
}
