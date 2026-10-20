import type { InformationIndex, MemorySearchResult, SourceEvidenceTarget } from "@do-soul/alaya-protocol";

const CLOSED_INDEX = new Set(["complete", "exhausted_empty"]);

/** Occupancy-tail fact from an admitted native index, independent of evaluator labels. */
export function admittedSourceDeliveryTail(index: Pick<InformationIndex, "continuation" | "completeness">):
  Readonly<{ status: "exhausted" | "open" | "unknown"; reason: string }> {
  if (index.continuation !== null) return { status: "open", reason: "occupancy_continuation_present" };
  const logical = index.completeness.logical_index;
  const observed = index.completeness.observed_coverage;
  if (CLOSED_INDEX.has(logical) && CLOSED_INDEX.has(observed)) {
    return { status: "exhausted", reason: logical === "exhausted_empty"
      ? "logical_index_exhausted_empty" : "logical_index_complete" };
  }
  return { status: "unknown", reason: CLOSED_INDEX.has(logical)
    ? `observed_coverage_${observed}` : `logical_index_${logical}` };
}

/** Projection only: callers must first admit the actual preview against sealed source bytes.
 * A valid clipped/omitted preview exposes fewer bytes than the promised index span. */
export function admittedSourcePreviewInterval(target: SourceEvidenceTarget,
  result: MemorySearchResult): Readonly<{ start: number; end: number }> | null {
  const span = target.span;
  if (span?.retained_extent !== "body") return null;
  const omitted = result.content_preview === "[payload omitted]" && !result.budget_state.within_budget;
  const empty = result.content_preview === "[empty source]" && span.content_start === span.content_end;
  const bytes = omitted || empty ? 0 : Buffer.byteLength(result.content_preview, "utf8");
  if (bytes > span.content_end - span.content_start) return null;
  return { start: span.content_start, end: span.content_start + bytes };
}
