import { z } from "zod";
import { AlayaError, canonicalJson, sourceGoldRootIdentity, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { hydrateUtf8Chunk } from "@do-soul/alaya-core";
import type { SourceIndexTarget, SourceSemanticNominationOccurrence } from "@do-soul/alaya-protocol";
import type { solveConditionalNavigation } from "./conditional-navigation.js";

export const FIELD_DELIVERY_LIMITS = { slots: 10, window_bytes: 4096 } as const;
const MAX_DELIVERY_BYTES = FIELD_DELIVERY_LIMITS.slots * FIELD_DELIVERY_LIMITS.window_bytes;

/** Private, explicitly frozen comparison. Omission retains historical delivery. */
export const FieldDeliverySchema = z.object({
  contract: z.literal("benchmark-field-delivery.v1"),
  selection: z.enum(["field-order", "condition-cover"]),
  windows: z.enum(["prefix", "native-anchor", "source-context"]),
  byte_budget: z.number().int().min(0).max(MAX_DELIVERY_BYTES),
  packing: z.literal("equal-share-prefix").optional()
}).strict().refine(policy => policy.packing === undefined || policy.windows === "prefix", "equal-share packing requires prefix windows");
export type FieldDelivery = z.infer<typeof FieldDeliverySchema>;

/** Private frozen comparison identities. Omission retains the original pair. */
export const FROZEN_DELIVERY_COMPARISONS = {
  "native-anchor": { "window-prefix": { windows: "prefix" }, "window-native-anchor": { windows: "native-anchor" } },
  "source-context": { "window-prefix": { windows: "prefix" }, "window-source-context": { windows: "source-context" } },
  "balanced-prefix": { "window-prefix": { windows: "prefix" },
    "window-balanced-prefix": { windows: "prefix", packing: "equal-share-prefix" } }
} as const;
export const SourceContextRouteSchema = z.enum(["whole-source", "native-anchor", "lexical-prefix", "unavailable"]);
export type SourceContextRoute = z.infer<typeof SourceContextRouteSchema>;
/** A lexical-only retained nominee has no native-window operation. An omitted or
 * unavailable vector window is UNKNOWN, never permission to retry with a prefix.
 * Short-source routing is independent of retrieval location; native extent and
 * complete bytes must still be admitted by the chosen read before publication. */
export function sourceContextRoute(source: SourceIndexTarget, witnesses: readonly SourceSemanticNominationOccurrence[]): SourceContextRoute {
  const candidates = witnesses.filter(hit => hit.source.target.root_id === source.target.root_id);
  if (candidates.length === 0) return "unavailable";
  if (source.body_bytes <= FIELD_DELIVERY_LIMITS.window_bytes) return "whole-source";
  const vectors = candidates.filter(hit => hit.route.kind === "vector");
  if (vectors.some(hit => hit.route.kind === "vector" && hit.route.window?.status === "available")) return "native-anchor";
  return vectors.length === 0 && candidates.every(hit => hit.route.kind === "lexical" && hit.route.hit === undefined)
    ? "lexical-prefix" : "unavailable";
}
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

/** Equal byte shares over the first nonempty prefix per root, at most ten roots.
 * Redistribute capacity from capped/short prefixes before UTF-8 flooring. Then
 * spend boundary slack on the next fitting codepoint of the least-filled prefix;
 * ties follow input order. No extra reads, source expansion or usefulness claim. */
function equalSharePrefixLimits(windows: readonly LiteralDeliveryWindow[], budget: number) {
  const seen = new Set<string>(), limits = windows.map(() => 0);
  const entries = windows.flatMap((window, index) => {
    const key = sourceGoldRootIdentity(window.target);
    if (!window.text || seen.has(key) || seen.size >= FIELD_DELIVERY_LIMITS.slots) return [];
    seen.add(key);
    return [{ index, body: Buffer.from(window.text), cap: Math.min(Buffer.byteLength(window.text), FIELD_DELIVERY_LIMITS.window_bytes) }];
  });
  let remaining = budget, active = [...entries];
  while (active.length) {
    const share = Math.floor(remaining / active.length), short = active.filter(entry => entry.cap <= share);
    if (short.length) {
      for (const entry of short) { limits[entry.index] = entry.cap; remaining -= entry.cap; }
      active = active.filter(entry => entry.cap > share);
    } else {
      const remainder = remaining % active.length;
      active.forEach((entry, i) => { limits[entry.index] = share + (i < remainder ? 1 : 0); });
      break;
    }
  }
  for (const entry of entries) {
    const chunk = hydrateUtf8Chunk(windows[entry.index]!.text, { byteLimit: limits[entry.index]! });
    limits[entry.index] = chunk.status === "chunk" ? chunk.end_offset : 0;
  }
  remaining = budget - limits.reduce((sum, n) => sum + n, 0);
  while (remaining > 0) {
    let best: { index: number; cost: number } | undefined;
    for (const entry of entries) {
      const allocated = limits[entry.index]!, byte = entry.body[allocated];
      if (byte === undefined) continue;
      const cost = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (cost <= remaining && allocated + cost <= entry.cap && (!best || allocated < limits[best.index]!)) best = { index: entry.index, cost };
    }
    if (!best) break;
    limits[best.index]! += best.cost; remaining -= best.cost;
  }
  return limits;
}

/** Ordered first-fit literal clipping unless equal-share prefix allocation is explicit.
 * At most one delivered window per root in the runner; this owner also subtracts
 * overlapping intervals for repeated input.
 * Only unique delivered UTF-8 bytes debit B. Dropped/clipped candidates do not
 * occupy output slots, and the caller must not promote their selected identities. */
export function packFieldWindows<T extends LiteralDeliveryWindow>(windows: readonly T[], budget: number, packing?: FieldDelivery["packing"]) {
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_DELIVERY_BYTES) throw new AlayaError("VALIDATION", "invalid delivery byte budget");
  for (const window of windows) {
    if (!Number.isSafeInteger(window.start) || window.start < 0 || window.end - window.start !== Buffer.byteLength(window.text)
      || Buffer.from(window.text).toString("utf8") !== window.text) {
      throw new AlayaError("VALIDATION", "literal delivery window extent mismatch");
    }
    if (packing && window.start !== 0) throw new AlayaError("VALIDATION", "equal-share packing requires prefix windows");
  }
  const limits = packing ? equalSharePrefixLimits(windows, budget) : undefined;
  const delivered: T[] = [], ranges = new Map<string, { start: number; end: number }[]>();
  let bytes = 0, duplicateBytes = 0;
  for (const [index, window] of windows.entries()) {
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
      const chunk = hydrateUtf8Chunk(text, { byteLimit: limits?.[index] ?? budget - bytes });
      if (chunk.status !== "chunk" || chunk.end_offset === 0) continue;
      const end = piece.start + chunk.end_offset;
      delivered.push({ ...window, rank: delivered.length + 1, start: piece.start, end, text: chunk.text });
      bytes += chunk.end_offset; prior.push({ start: piece.start, end });
    }
    ranges.set(key, prior);
  }
  const extents = packing || windows.some(window => "context_route" in window) ? windows.map(window => {
    const packed = delivered.find(item => sourceGoldRootIdentity(item.target) === sourceGoldRootIdentity(window.target));
    return { record_id: window.target.root_id, status: !packed ? "omitted" : packed.start === window.start && packed.end === window.end ? "complete" : "partial",
      read_start: window.start, read_end: window.end, delivered_start: packed?.start ?? null, delivered_end: packed?.end ?? null };
  }) : undefined;
  return { windows: delivered, unique_utf8_bytes: bytes, duplicate_input_bytes: duplicateBytes,
    ...(packing ? { prefix_packing: extents } : {}),
    ...(!packing && extents ? { source_context_packing: extents } : {}),
    input_utf8_bytes: windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0),
    byte_budget: budget, total_slots: FIELD_DELIVERY_LIMITS.slots, per_message_slots: 1 };
}
