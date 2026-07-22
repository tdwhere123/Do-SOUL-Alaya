import {
  buildSourceVerificationText,
  filterSourceAssertionEntities,
  resolveGardenRawPayloadGrounding
} from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput } from "../daemon/daemon-types.js";

export function attachCompileSourceGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput,
  safeExcerpt: string
): Record<string, unknown> {
  const proposal = readProposal(rawPayload, signalInput);
  const safePayload = stripDerivedGrounding(rawPayload);
  const proposedMatch = proposal.proposed_matched_text;
  const resolution = resolveGardenRawPayloadGrounding({
    ...rawPayload,
    full_turn_content: rawPayload.full_turn_content ?? signalInput.turnContent,
    proposed_matched_text: rawPayload.proposed_matched_text ?? proposedMatch
  });
  if (resolution.status === "rejected") {
    return rejectedPayload(safePayload, safeExcerpt, proposal, resolution.reason);
  }
  const groundedCanonicalEntities = Array.isArray(proposal.proposed_canonical_entities)
    ? filterSourceAssertionEntities(
        proposal.proposed_canonical_entities.filter((entity): entity is string => typeof entity === "string"),
        resolution.assertion
      )
    : [];
  return {
    ...safePayload,
    matched_text: resolution.assertion,
    distilled_fact: resolution.assertion,
    full_turn_content: buildSourceVerificationText(signalInput.turnContent, resolution.assertion),
    source_assertion: resolution.assertion,
    ...(groundedCanonicalEntities.length === 0 ? {} : { canonical_entities: groundedCanonicalEntities }),
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
        proposal.proposed_preference_profile
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
    "source_assertion", "source_grounding", "proposed_matched_text", "proposed_distilled_fact"
  ]) delete safe[key];
  return safe;
}

function rejectedPayload(
  safePayload: Readonly<Record<string, unknown>>,
  safeExcerpt: string,
  proposal: Readonly<Record<string, unknown>>,
  reason: string
): Record<string, unknown> {
  return {
    ...safePayload,
    full_turn_content: safeExcerpt,
    proposed_matched_text: proposal.proposed_matched_text,
    source_grounding: { ...proposal, status: "rejected", content_basis: "none", reasons: [reason] }
  };
}

function groundingReasons(
  proposedMatch: string,
  assertion: string,
  canonicalEntities: unknown,
  preferenceProfile: unknown
): readonly string[] {
  const reasons: string[] = [];
  if (proposedMatch !== assertion) reasons.push("matched_text_expanded_to_source_assertion");
  if (canonicalEntities !== undefined) reasons.push("unverified_canonical_entities_removed");
  if (preferenceProfile !== undefined) reasons.push("unverified_preference_profile_removed");
  return reasons;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
