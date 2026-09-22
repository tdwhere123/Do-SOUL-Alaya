import {
  sourceSemanticEvidenceClosure, SourceSemanticResourceExhausted,
  type SourceSemanticInterpretation, type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { sliceUtf8Span } from "./source-span-views.js";

type SupportWindow = Readonly<{
  status: "available"; text: string; start_offset: number; end_offset: number;
  source_complete: boolean;
}> & (Readonly<{ kind: "support_window" }> | Readonly<{ kind: "whole_source"; fallback_reason: "location_missing" }>);

type SupportUnavailable = Readonly<{
  status: "unavailable";
  reason: "no_dependencies" | "unknown_dependency" | "location_missing" | "display_budget" | "resource_budget";
}>;

/**
 * Requires the current authorized source and interpretation returned by source
 * publication/location verification. dependency_ids are canonical source handles
 * mapped by the actual selected proof's origin owner, not a union of other answers
 * or a reconstruction from output values. Derived/query coordinates are not roots.
 *
 * Available means that the represented dependencies fit, not complete language
 * fidelity or a complete source root. source_complete only covers the supplied
 * retained source string, not any omitted original. Reading remains the caller's metered
 * responsibility; this operation charges its own reference and byte processing.
 */
export function sourceSemanticSupportWindow(input: Readonly<{
  source: string; interpretation: SourceSemanticInterpretation;
  dependency_ids: readonly string[]; max_bytes: number; meter: SourceSemanticResourceLedger;
}>): SupportWindow | SupportUnavailable {
  if (!Number.isSafeInteger(input.max_bytes) || input.max_bytes < 0) {
    throw new CoreError("VALIDATION", "source support display budget must be a nonnegative safe integer");
  }
  if (input.dependency_ids.length === 0) return { status: "unavailable", reason: "no_dependencies" };
  try { return locateWindow(input); }
  catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return { status: "unavailable", reason: "resource_budget" };
    throw error;
  }
}

function locateWindow(input: Parameters<typeof sourceSemanticSupportWindow>[0]): SupportWindow | SupportUnavailable {
  const { source, interpretation, meter } = input;
  const required = sourceSemanticEvidenceClosure(interpretation, input.dependency_ids, meter);
  const nodes = new Map([
    ...interpretation.mentions, ...interpretation.referents, ...interpretation.frames,
    ...interpretation.operators, ...(interpretation.domains ?? []), ...(interpretation.measurements ?? [])
  ].map((row) => [row.id, row]));
  const assertions = new Set<number>();
  let missing = false;
  for (const id of required) {
    meter.charge(1, 32, "source support locations");
    const row = nodes.get(id);
    if (row === undefined) return { status: "unavailable", reason: "unknown_dependency" };
    if ("assertion_id" in row) assertions.add(row.assertion_id);
    if ("assertion_ids" in row) for (const assertion of row.assertion_ids) assertions.add(assertion);
    // Unexpressed identities can be valid semantic inputs without a source quote.
    if ("referent_kind" in row && row.mentions.length === 0) missing = true;
  }
  const locations = new Map(interpretation.source.assertion_locations?.map((row) => [row.assertion_id, row.source_utf8_span]));
  let start = Infinity, end = 0;
  for (const id of assertions) {
    meter.charge(1, 0, "source support intervals");
    const span = locations.get(id);
    if (span === undefined) { missing = true; continue; }
    start = Math.min(start, span[0]); end = Math.max(end, span[1]);
  }
  meter.charge(source.length, 0, "source support byte extent");
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (missing || assertions.size === 0) {
    if (sourceBytes === 0 || sourceBytes > input.max_bytes) return { status: "unavailable", reason: "location_missing" };
    return { ...extract(input, 0, sourceBytes, sourceBytes), kind: "whole_source", fallback_reason: "location_missing" };
  }
  if (end - start > input.max_bytes) return { status: "unavailable", reason: "display_budget" };
  return { ...extract(input, start, end, sourceBytes), kind: "support_window" };
}

function extract(input: Parameters<typeof sourceSemanticSupportWindow>[0], start: number, end: number, sourceBytes: number) {
  // The shared span owner encodes the source for validation and slicing. Charge
  // both allocations before invoking it, even when the displayed window is tiny.
  input.meter.charge(input.source.length * 2 + end - start, sourceBytes * 2 + (end - start) * 2, "source support UTF-8 slice");
  const text = sliceUtf8Span(input.source, { start_offset: start, end_offset: end, purpose: "native_structure" });
  return { status: "available" as const, text, start_offset: start, end_offset: end,
    source_complete: start === 0 && end === sourceBytes };
}
