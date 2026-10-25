import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { HOST_OCCURRENCE_LIMITS, hostOccurrenceIsMessage } from "../conversation/host-occurrence.js";

/** Projection of admitted host facts, not inferred boundaries. Empty/excerpt facts survive projection. */
export const SourceIndexMessageStructureSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown") }).strict(),
  z.object({ status: z.literal("not_applicable") }).strict(),
  z.object({ status: z.literal("captured"), occurrences: z.array(z.object({
    utf8_span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).readonly(),
    completeness: z.enum(["complete", "excerpt", "unknown"])
  }).strict().readonly()).max(HOST_OCCURRENCE_LIMITS.count).readonly() }).strict()
]).readonly();
export type SourceIndexMessageStructure = z.infer<typeof SourceIndexMessageStructureSchema>;

/** Contiguous, nonoverlapping coverage. Whole bounded messages take precedence over balancing.
 * Oversized messages and unstructured gaps allow UTF-8 splits; no marker/line inference.
 * Only the final two windows are rebalanced, at legal boundaries, without raising the byte cap.
 * Token limits remain the embedding owner's exact prepared-token refusal, not a bytes/token estimate.
 */
export function messageWindowIntervals(bytes: Uint8Array, cap: number, value: SourceIndexMessageStructure,
  maxWindows: number): readonly (readonly [number, number])[] | null {
  const structure = SourceIndexMessageStructureSchema.parse(value);
  const boundary = (offset: number) => offset <= bytes.length &&
    (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80);
  let previousEnd = 0;
  const protectedSpans: (readonly [number, number])[] = [];
  if (structure.status === "captured") for (const occurrence of structure.occurrences) {
    const [start, end] = occurrence.utf8_span;
    if (start < previousEnd || end < start || !boundary(start) || !boundary(end)) {
      throw new AlayaError("VALIDATION", "source index message extent differs from exact source bytes");
    }
    previousEnd = end;
    if (hostOccurrenceIsMessage(occurrence) && end - start <= cap) {
      protectedSpans.push([start, end]);
    }
  }
  const legal = (offset: number) => boundary(offset) &&
    !protectedSpans.some(([start, end]) => start < offset && offset < end);
  const intervals: [number, number][] = [];
  for (let start = 0; start < bytes.length;) {
    if (intervals.length >= maxWindows) return null;
    let end = Math.min(bytes.length, start + cap);
    while (!boundary(end)) end--;
    const containing = protectedSpans.find(([left, right]) => left < end && end < right);
    if (containing !== undefined) end = containing[0];
    if (end === start) throw new AlayaError("VALIDATION", "source index message window cannot advance");
    intervals.push([start, end]);
    start = end;
  }
  if (intervals.length >= 2) {
    const left = intervals[intervals.length - 2]!, right = intervals[intervals.length - 1]!;
    const [start, end] = [left[0], right[1]];
    let split = left[1], imbalance = Math.abs((split - start) - (end - split));
    for (let candidate = Math.max(start + 1, end - cap); candidate <= Math.min(end - 1, start + cap); candidate++) {
      const difference = Math.abs((candidate - start) - (end - candidate));
      if (difference < imbalance && legal(candidate)) { split = candidate; imbalance = difference; }
    }
    left[1] = split; right[0] = split;
  }
  return intervals;
}
