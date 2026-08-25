import type { OpenSemanticFactorFormationCapture } from
  "@do-soul/alaya-protocol";
import type { OpenSemanticFactorCompatibilityTrace } from
  "./compatibility-trace.js";

export type OpenSemanticFactorCompositionStatus =
  | "composed"
  | "no_match"
  | "ineligible"
  | "unavailable"
  | "rejected";

export function classifyOpenSemanticFactorCompositionStatus(params: Readonly<{
  readonly query: Readonly<OpenSemanticFactorFormationCapture>;
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly solutionCount: number;
  readonly truncated: boolean;
}>): OpenSemanticFactorCompositionStatus {
  const { query, trace, solutionCount, truncated } = params;
  if (query.status === "rejected") return "rejected";
  if (query.status === "ineligible") return "ineligible";
  if (query.status !== "formed") return "unavailable";
  if (solutionCount > 0) return "composed";
  const statuses = new Set(trace.entries.map(({ receipt }) => receipt.status));
  if (trace.incomparable_seal === "rejected" || statuses.has("rejected")) {
    return "rejected";
  }
  const finishedIncompatible = !truncated && !trace.truncated &&
    trace.entries.length > 0 &&
    trace.entries.every(({ receipt }) => receipt.status === "incompatible");
  if (finishedIncompatible) return "no_match";
  if (trace.incomparable_seal === "unavailable" || statuses.has("unavailable")) {
    return "unavailable";
  }
  if (trace.incomparable_seal === "ineligible" || statuses.has("ineligible")) {
    return "ineligible";
  }
  // Truncation and empty traces are unobserved, not exhaustive no_match.
  return truncated || trace.truncated || trace.entries.length === 0
    ? "unavailable"
    : "no_match";
}
