import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { SourceAssertionResolution } from "./source-assertion.js";
import { resolvePreferenceAwareSourceGrounding } from "./preference-profile.js";
import { parseOfficialApiSourceLocator } from "./source-locator.js";

export type GardenSignalGrounding = SourceAssertionResolution | {
  readonly status: "rejected";
  readonly reason: "source_grounding_missing" | "source_grounding_rejected";
};

export function resolveGardenSignalGrounding(
  signal: CandidateMemorySignal
): GardenSignalGrounding {
  return resolveGardenRawPayloadGrounding(signal.raw_payload);
}

export function resolveGardenRawPayloadGrounding(
  rawPayload: CandidateMemorySignal["raw_payload"]
): GardenSignalGrounding {
  const grounding = readRecord(rawPayload.source_grounding);
  const proposedMatch = readString(rawPayload.proposed_matched_text) ??
    readString(grounding?.proposed_matched_text) ??
    readString(rawPayload.matched_text);
  // Product trusts only full_turn_content; bench must project into that key at seed.
  const fullTurn = readString(rawPayload.full_turn_content);
  if (fullTurn === null || proposedMatch === null) {
    return { status: "rejected", reason: "source_grounding_missing" };
  }
  if (Object.hasOwn(rawPayload, "source_locator") &&
      parseOfficialApiSourceLocator(rawPayload.source_locator) === null) {
    return { status: "rejected", reason: "source_grounding_rejected" };
  }
  const resolution = resolvePreferenceAwareSourceGrounding({
    proposal: rawPayload.preference_profile,
    sourceCorpus: fullTurn,
    proposedMatch,
    ...(Object.hasOwn(rawPayload, "source_locator")
      ? { sourceLocator: rawPayload.source_locator }
      : {})
  }).resolution;
  if (resolution.status === "rejected") return resolution;
  const storedAssertion = readString(rawPayload.source_assertion);
  return storedAssertion !== null && storedAssertion !== resolution.assertion
    ? { status: "rejected", reason: "source_grounding_rejected" }
    : resolution;
}

export function requiresGardenSourceGrounding(signal: CandidateMemorySignal): boolean {
  return signal.source === "garden_compile";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
