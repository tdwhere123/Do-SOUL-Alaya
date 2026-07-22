import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { resolveSourceAssertion, type SourceAssertionResolution } from "./source-assertion.js";
import {
  locatorAssertionUniquelyCommitsToQuote,
  parseOfficialApiSourceLocator,
  resolveOfficialApiSourceLocator
} from "./source-locator.js";

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
  if (grounding?.status === "rejected") {
    return { status: "rejected", reason: "source_grounding_rejected" };
  }
  const proposedMatch = readString(rawPayload.proposed_matched_text) ??
    readString(rawPayload.matched_text);
  // Product trusts only full_turn_content; bench must project into that key at seed.
  const fullTurn = readString(rawPayload.full_turn_content);
  if (Object.hasOwn(rawPayload, "source_locator")) {
    const locator = parseOfficialApiSourceLocator(rawPayload.source_locator);
    if (fullTurn === null || locator === null || proposedMatch === null) {
      return { status: "rejected", reason: "source_grounding_rejected" };
    }
    const resolution = resolveOfficialApiSourceLocator(fullTurn, locator);
    const storedAssertion = readString(rawPayload.source_assertion) ??
      readString(rawPayload.matched_text);
    if (resolution.status === "rejected" || storedAssertion !== resolution.assertion ||
        !locatorAssertionUniquelyCommitsToQuote(fullTurn, resolution.assertion, proposedMatch)) {
      return { status: "rejected", reason: "source_grounding_rejected" };
    }
    return resolution;
  }
  if (fullTurn !== null && proposedMatch !== null) {
    return resolveSourceAssertion(fullTurn, proposedMatch);
  }
  return { status: "rejected", reason: "source_grounding_missing" };
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
