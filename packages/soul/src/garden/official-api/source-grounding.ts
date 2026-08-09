import {
  groundAssociativeFactFrame,
  groundOpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import type {
  OfficialApiPreferenceProfileDraft,
  OfficialApiSignalDraft
} from "../official-api-signal-parser.js";
import {
  filterSourceAssertionEntities,
  type SourceAssertionRejectionReason
} from "../grounding/source-assertion.js";
import {
  preferenceProfileGroundingRemovalReason,
  resolvePreferenceAwareSourceGrounding
} from "../grounding/preference-profile.js";
import type { OfficialApiSourceTrustRejection } from "./source-trust.js";

interface OfficialApiSourceGroundingProposal {
  readonly version: 1;
  readonly proposed_matched_text: string;
  readonly proposed_distilled_fact?: string;
  readonly proposed_canonical_entities?: readonly string[];
  readonly proposed_preference_profile?: OfficialApiPreferenceProfileDraft;
  readonly proposed_fact_frame?: OfficialApiSignalDraft["fact_frame"];
  readonly proposed_semantic_factor_graph?: OfficialApiSignalDraft["semantic_factor_graph"];
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
  sourceText: string,
  preferenceSourceCorpus = sourceText
): OfficialApiGroundingResult {
  const preferenceGrounding = resolvePreferenceAwareSourceGrounding({
    proposal: draft.preference_profile,
    sourceText,
    sourceCorpus: preferenceSourceCorpus,
    proposedMatch: draft.matched_text,
    ...(draft.source_locator === undefined ? {} : { sourceLocator: draft.source_locator })
  });
  const resolution = preferenceGrounding.resolution;
  if (resolution.status === "rejected") return rejectedGrounding(draft, resolution.reason);
  const assertion = resolution.assertion;
  const canonicalEntities = groundCanonicalEntities(draft.canonical_entities, assertion);
  const preferenceProfile = preferenceGrounding.preferenceProfile;
  const factFrame = groundAssociativeFactFrame(draft.fact_frame, assertion) ?? undefined;
  const semanticFactorGraph = groundEvidenceSemanticFactorGraph(
    draft.semantic_factor_graph,
    assertion
  );
  const reasons = groundingReasons(
    draft,
    assertion,
    canonicalEntities,
    preferenceProfile,
    factFrame,
    semanticFactorGraph
  );
  const {
    matched_text: _matchedText,
    distilled_fact: _distilledFact,
    canonical_entities: _canonicalEntities,
    preference_profile: _preferenceProfile,
    fact_frame: _factFrame,
    semantic_factor_graph: _semanticFactorGraph,
    ...rest
  } = draft;
  const groundedDraft: OfficialApiSignalDraft = Object.freeze({
    ...rest,
    matched_text: assertion,
    distilled_fact: assertion,
    ...(canonicalEntities.length === 0 ? {} : { canonical_entities: canonicalEntities }),
    ...(preferenceProfile === undefined ? {} : { preference_profile: preferenceProfile }),
    ...(factFrame === undefined ? {} : { fact_frame: factFrame }),
    ...(semanticFactorGraph === undefined
      ? {}
      : { semantic_factor_graph: semanticFactorGraph })
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
      ...(draft.fact_frame === undefined ? {} : { proposed_fact_frame: draft.fact_frame }),
      ...(draft.semantic_factor_graph === undefined
        ? {}
        : { proposed_semantic_factor_graph: draft.semantic_factor_graph }),
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
    fact_frame: _factFrame,
    semantic_factor_graph: _semanticFactorGraph,
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
      ...(draft.fact_frame === undefined ? {} : { proposed_fact_frame: draft.fact_frame }),
      ...(draft.semantic_factor_graph === undefined
        ? {}
        : { proposed_semantic_factor_graph: draft.semantic_factor_graph }),
      reasons: Object.freeze([reason])
    })
  };
}

function groundingReasons(
  draft: OfficialApiSignalDraft,
  assertion: string,
  canonicalEntities: readonly string[],
  preferenceProfile: OfficialApiPreferenceProfileDraft | undefined,
  factFrame: OfficialApiSignalDraft["fact_frame"],
  semanticFactorGraph: OfficialApiSignalDraft["semantic_factor_graph"]
): readonly string[] {
  const reasons: string[] = [];
  if (draft.matched_text.trim() !== assertion) reasons.push("matched_text_expanded_to_source_assertion");
  if (draft.distilled_fact !== undefined && !assertion.includes(draft.distilled_fact.trim())) {
    reasons.push("proposed_distilled_fact_not_verbatim");
  }
  if ((draft.canonical_entities?.length ?? 0) !== canonicalEntities.length) {
    reasons.push("unverified_canonical_entities_removed");
  }
  const profileReason = preferenceProfileGroundingRemovalReason(
    draft.preference_profile,
    preferenceProfile
  );
  if (profileReason !== undefined) reasons.push(profileReason);
  if (draft.fact_frame !== undefined && factFrame === undefined) {
    reasons.push("proposed_fact_frame_not_source_grounded");
  }
  if (draft.semantic_factor_graph !== undefined && semanticFactorGraph === undefined) {
    reasons.push("proposed_semantic_factor_graph_not_source_grounded");
  }
  return reasons;
}

function groundEvidenceSemanticFactorGraph(
  proposal: OfficialApiSignalDraft["semantic_factor_graph"],
  assertion: string
): OfficialApiSignalDraft["semantic_factor_graph"] {
  const graph = groundOpenSemanticFactorGraph(proposal, assertion);
  return graph?.source_kind === "evidence" ? proposal : undefined;
}

function groundCanonicalEntities(
  entities: readonly string[] | undefined,
  assertion: string
): readonly string[] {
  if (entities === undefined) return [];
  return filterSourceAssertionEntities(entities, assertion);
}
