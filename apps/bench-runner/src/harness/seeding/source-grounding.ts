import {
  buildOfficialApiSourceCorpus,
  filterSourceAssertionEntities,
  preferenceProfileGroundingRemovalReason,
  resolvePreferenceAwareSourceGrounding
} from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput } from "../daemon/daemon-types.js";

export function attachCompileSourceGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput
): Record<string, unknown> {
  const proposal = readProposal(rawPayload, signalInput);
  const safePayload = stripDerivedGrounding(rawPayload);
  const proposedMatch = proposal.proposed_matched_text;
  const sourceCorpus = signalInput.turnMessages === undefined
    ? signalInput.turnContent
    : buildOfficialApiSourceCorpus(signalInput.turnContent, signalInput.turnMessages);
  const cachedSourceCorpus = readCachedSourceCorpus(rawPayload.full_turn_content);
  if (cachedSourceCorpus !== null && cachedSourceCorpus !== sourceCorpus) {
    return rejectedPayload(
      safePayload,
      sourceCorpus,
      proposal,
      "cached_source_corpus_mismatch"
    );
  }
  const grounding = resolvePreferenceAwareSourceGrounding({
    proposal: proposal.proposed_preference_profile,
    sourceCorpus,
    proposedMatch,
    ...(safePayload.source_locator === undefined
      ? {}
      : { sourceLocator: safePayload.source_locator })
  });
  const resolution = grounding.resolution;
  if (resolution.status === "rejected") {
    return rejectedPayload(safePayload, sourceCorpus, proposal, resolution.reason);
  }
  const groundedCanonicalEntities = Array.isArray(proposal.proposed_canonical_entities)
    ? filterSourceAssertionEntities(
        proposal.proposed_canonical_entities.filter((entity): entity is string => typeof entity === "string"),
        resolution.assertion
      )
    : [];
  const groundedPreferenceProfile = grounding.preferenceProfile;
  return {
    ...safePayload,
    matched_text: resolution.assertion,
    distilled_fact: resolution.assertion,
    full_turn_content: sourceCorpus,
    source_assertion: resolution.assertion,
    ...(groundedCanonicalEntities.length === 0 ? {} : { canonical_entities: groundedCanonicalEntities }),
    ...(groundedPreferenceProfile === undefined ? {} : { preference_profile: groundedPreferenceProfile }),
    proposed_matched_text: proposedMatch,
    source_grounding: {
      ...proposal,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: resolution.assertion,
      reasons: groundingReasons(
        proposedMatch,
        resolution.assertion,
        proposal.proposed_canonical_entities,
        proposal.proposed_preference_profile,
        groundedPreferenceProfile
      )
    }
  };
}

function readProposal(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput
): Record<string, unknown> & { readonly proposed_matched_text: string } {
  const prior = isRecord(rawPayload.source_grounding) ? rawPayload.source_grounding : {};
  const proposedMatch = readString(prior.proposed_matched_text) ??
    readString(rawPayload.proposed_matched_text) ?? readString(rawPayload.matched_text) ??
    signalInput.matchedText?.trim() ?? signalInput.distilledFact.trim();
  const distilled = readString(prior.proposed_distilled_fact) ?? readString(rawPayload.distilled_fact);
  return {
    version: 1,
    proposed_matched_text: proposedMatch,
    ...(distilled === null ? {} : { proposed_distilled_fact: distilled }),
    ...proposalField(prior, rawPayload, "proposed_canonical_entities", "canonical_entities"),
    ...proposalField(prior, rawPayload, "proposed_preference_profile", "preference_profile")
  };
}

function proposalField(
  prior: Readonly<Record<string, unknown>>,
  raw: Readonly<Record<string, unknown>>,
  proposedKey: string,
  rawKey: string
): Record<string, unknown> {
  const value = prior[proposedKey] ?? raw[rawKey];
  return value === undefined ? {} : { [proposedKey]: value };
}

function stripDerivedGrounding(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe = { ...raw };
  for (const key of [
    "matched_text", "distilled_fact", "canonical_entities", "preference_profile",
    "source_assertion", "source_grounding", "proposed_matched_text", "proposed_distilled_fact",
    "proposed_canonical_entities", "proposed_preference_profile"
  ]) delete safe[key];
  return safe;
}

function rejectedPayload(
  safePayload: Readonly<Record<string, unknown>>,
  sourceCorpus: string,
  proposal: Readonly<Record<string, unknown>>,
  reason: string
): Record<string, unknown> {
  return {
    ...safePayload,
    full_turn_content: sourceCorpus,
    proposed_matched_text: proposal.proposed_matched_text,
    source_grounding: { ...proposal, status: "rejected", content_basis: "none", reasons: [reason] }
  };
}

function groundingReasons(
  proposedMatch: string,
  assertion: string,
  canonicalEntities: unknown,
  preferenceProfile: unknown,
  groundedPreferenceProfile: unknown
): readonly string[] {
  const reasons: string[] = [];
  if (proposedMatch !== assertion) reasons.push("matched_text_expanded_to_source_assertion");
  if (canonicalEntities !== undefined) reasons.push("unverified_canonical_entities_removed");
  const profileReason = preferenceProfileGroundingRemovalReason(
    preferenceProfile,
    groundedPreferenceProfile
  );
  if (profileReason !== undefined) reasons.push(profileReason);
  return reasons;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCachedSourceCorpus(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
