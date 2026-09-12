import { parseOfficialApiRequestSignals } from "../compute-provider.js";
import type { OfficialApiExtractionRequest } from "./extraction-request.js";
import { resolvePreferenceAwareSourceGrounding } from "../../triage/grounding/preference-profile.js";

/** Completion describes the extraction request, not exhaustive memory formation. */
export function classifyOfficialApiRequestResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  const envelope: unknown = JSON.parse(rawJson);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
      !("signals" in envelope) || !Array.isArray(envelope.signals)) {
    throw new Error("official API completed result requires a signals array");
  }
  const drafts = parseOfficialApiRequestSignals(rawJson, request, sourceCorpus);
  if (drafts.length !== envelope.signals.length) {
    throw new Error("official API completed result contains rejected signal entries");
  }
  const assertions = new Map(request.source_assertions.map((assertion) => [assertion.assertion_id, assertion.text]));
  for (const draft of drafts) {
    const assertion = draft.source_locator === undefined ? undefined : assertions.get(draft.source_locator.assertion_id);
    if (assertion === undefined || resolvePreferenceAwareSourceGrounding({
      sourceCorpus: assertion, proposedMatch: draft.matched_text, proposal: draft.preference_profile
    }).resolution.status !== "grounded") {
      throw new Error("official API completed result requires a grounded source locator");
    }
  }
  return Object.freeze({ status: drafts.length === 0 ? "completed_empty" as const : "completed_signals" as const, drafts });
}
