import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { resolveSourceAssertion, type SourceAssertionResolution } from "./source-assertion.js";

type GardenSignalGrounding = SourceAssertionResolution | {
  readonly status: "rejected";
  readonly reason: "source_grounding_missing" | "source_grounding_rejected";
};

export function resolveGardenSignalGrounding(
  signal: CandidateMemorySignal
): GardenSignalGrounding {
  const grounding = readRecord(signal.raw_payload.source_grounding);
  if (grounding?.status === "rejected") {
    return { status: "rejected", reason: "source_grounding_rejected" };
  }
  const proposedMatch = readString(signal.raw_payload.proposed_matched_text) ??
    readString(signal.raw_payload.matched_text);
  const fullTurn = readString(signal.raw_payload.full_turn_content) ??
    readString(signal.raw_payload.bench_full_turn_content);
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
