import { z } from "zod";
import { AlayaError, canonicalJson, sourceGoldRootIdentity, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { hydrateUtf8Chunk } from "@do-soul/alaya-core";
import type { solveConditionalNavigation } from "./conditional-navigation.js";

export const FIELD_DELIVERY_LIMITS = { slots: 10, window_bytes: 4096 } as const;
const MAX_DELIVERY_BYTES = FIELD_DELIVERY_LIMITS.slots * FIELD_DELIVERY_LIMITS.window_bytes;

/** Private, explicitly frozen comparison. Omission retains historical delivery. */
export const FieldDeliverySchema = z.object({
  contract: z.literal("benchmark-field-delivery.v1"),
  selection: z.enum(["field-order", "condition-cover"]),
  windows: z.enum(["prefix", "native-anchor"]),
  byte_budget: z.number().int().min(0).max(MAX_DELIVERY_BYTES)
}).strict();
export type FieldDelivery = z.infer<typeof FieldDeliverySchema>;
type Solved = ReturnType<typeof solveConditionalNavigation>;

/** Greedy branch-navigation coverage, NOT factual support. Each existing compatible
 * max/min branch is one coverage coordinate; unknown/partial/known-outside never
 * covers it. Equal marginal counts retain the field's complete stable tie order.
 * The original OR branch remains a coordinate and every candidate remains eligible.
 * After all obtainable coordinates are covered, the remaining order is unchanged. */
export function selectFieldDelivery(solved: Solved, policy: FieldDelivery) {
  const coverage = new Map(solved.rows.map(row => [row.record_id, new Set(solved.assessments
    .filter(a => a.record_id === row.record_id && a.status === "known" && a.tier !== null
      && !solved.temporal_observations?.some(t => t.record_id === a.record_id && a.conditions.includes(t.condition)
        && t.observation.relation !== "inside"))
    .map(a => canonicalJson([...a.conditions].sort())))]));
  const remaining = [...solved.rows], selected: Solved["rows"] = [], covered = new Set<string>();
  const steps: { record_id: string; newly_covered: string[] }[] = [];
  while (remaining.length && selected.length < FIELD_DELIVERY_LIMITS.slots) {
    let best = 0, gain = -1;
    if (policy.selection === "condition-cover") for (const [i, row] of remaining.entries()) {
      const count = [...coverage.get(row.record_id)!].filter(key => !covered.has(key)).length;
      if (count > gain) { best = i; gain = count; }
    }
    const row = remaining.splice(best, 1)[0]!;
    const newly_covered = [...coverage.get(row.record_id)!].filter(key => !covered.has(key));
    newly_covered.forEach(key => covered.add(key)); selected.push(row);
    steps.push({ record_id: row.record_id, newly_covered });
  }
  return { rows: selected, steps, coverage_kind: "known_branch_navigation_only" as const,
    status: selected.every((row, i) => row.record_id === solved.rows[i]?.record_id) ? "no_op" as const : "changed" as const,
    conditional_support: "unknown" as const };
}

export type LiteralDeliveryWindow = { rank: number; source_id: string; target: SourceEvidenceTarget;
  start: number; end: number; text: string };

/** Ordered first-fit literal clipping. At most one delivered window per root in
 * the runner; this owner also subtracts overlapping intervals for repeated input.
 * Only unique delivered UTF-8 bytes debit B. Dropped/clipped candidates do not
 * occupy output slots, and the caller must not promote their selected identities. */
export function packFieldWindows<T extends LiteralDeliveryWindow>(windows: readonly T[], budget: number) {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_DELIVERY_BYTES) throw new AlayaError("VALIDATION", "invalid delivery byte budget");
  const delivered: T[] = [], ranges = new Map<string, { start: number; end: number }[]>();
  let bytes = 0, duplicateBytes = 0;
  for (const window of windows) {
    if (!Number.isSafeInteger(window.start) || window.start < 0 || window.end - window.start !== Buffer.byteLength(window.text)
      || Buffer.from(window.text).toString("utf8") !== window.text) {
      throw new AlayaError("VALIDATION", "literal delivery window extent mismatch");
    }
    const key = sourceGoldRootIdentity(window.target);
    const prior = ranges.get(key) ?? [];
    let pieces = [{ start: window.start, end: window.end }];
    for (const old of prior) pieces = pieces.flatMap(piece => old.start >= piece.end || old.end <= piece.start ? [piece]
      : [{ start: piece.start, end: Math.min(piece.end, old.start) }, { start: Math.max(piece.start, old.end), end: piece.end }]
        .filter(piece => piece.end > piece.start));
    duplicateBytes += window.end - window.start - pieces.reduce((n, p) => n + p.end - p.start, 0);
    for (const piece of pieces) {
      if (prior.length > 0 || delivered.length >= FIELD_DELIVERY_LIMITS.slots || bytes >= budget) break;
      const text = Buffer.from(window.text).subarray(piece.start - window.start, piece.end - window.start).toString("utf8");
      const chunk = hydrateUtf8Chunk(text, { byteLimit: budget - bytes });
      if (chunk.status !== "chunk" || chunk.end_offset === 0) continue;
      const end = piece.start + chunk.end_offset;
      delivered.push({ ...window, rank: delivered.length + 1, start: piece.start, end, text: chunk.text });
      bytes += chunk.end_offset; prior.push({ start: piece.start, end });
    }
    ranges.set(key, prior);
  }
  return { windows: delivered, unique_utf8_bytes: bytes, duplicate_input_bytes: duplicateBytes,
    input_utf8_bytes: windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0),
    byte_budget: budget, total_slots: FIELD_DELIVERY_LIMITS.slots, per_message_slots: 1 };
}
