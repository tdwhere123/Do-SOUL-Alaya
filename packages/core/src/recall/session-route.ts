import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { compareMemoryEntries } from "./recall-service-helpers.js";
import { uniqueStrings } from "./path-relations.js";

// Opt-in: NL queries carry no `surface-` token, so inject the dominant foothold session's surface_id to wake exact-cohort.
export function sessionRouteEnabled(): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env.ALAYA_RECALL_SESSION_ROUTE ?? "");
}

const SESSION_ROUTE_FOOTHOLD_TOP_K = 12;
// Min foothold share to count as the routed anchor; an even split routes nothing.
const SESSION_ROUTE_DOMINANCE_RATIO = 0.5;
const SESSION_ROUTE_MIN_FOOTHOLDS = 3;

// Reads the dominant surface_id among the strongest footholds; empty when no session dominates.
export function resolveRoutedSurfaceIds(
  tierMemories: readonly Readonly<MemoryEntry>[],
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  const footholds = selectLexicalFootholds(tierMemories, queryProbes);
  if (footholds.length < SESSION_ROUTE_MIN_FOOTHOLDS) {
    return [];
  }
  const dominant = selectDominantSurfaceId(footholds);
  return dominant === null ? [] : [dominant];
}

// Merge routed surface_ids so exact-cohort admission and object-probe scoring treat the session as a structural match.
export function withRoutedSurfaceIds(
  queryProbes: Readonly<RecallQueryProbes>,
  routedSurfaceIds: readonly string[]
): Readonly<RecallQueryProbes> {
  const merged = uniqueStrings([...queryProbes.surface_ids, ...routedSurfaceIds]);
  if (merged.length === queryProbes.surface_ids.length) {
    return queryProbes;
  }
  return Object.freeze({
    ...queryProbes,
    surface_ids: Object.freeze(merged)
  });
}

function selectLexicalFootholds(
  tierMemories: readonly Readonly<MemoryEntry>[],
  queryProbes: Readonly<RecallQueryProbes>
): readonly Readonly<MemoryEntry>[] {
  return tierMemories
    .map((entry) => Object.freeze({ entry, score: scoreLexicalFoothold(entry, queryProbes) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    )
    .slice(0, SESSION_ROUTE_FOOTHOLD_TOP_K)
    .map((scored) => scored.entry);
}

// Deterministic lexical-overlap proxy over the tier page (no extra FTS I/O).
function scoreLexicalFoothold(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  if (queryProbes.lexical_terms.length === 0) {
    return 0;
  }
  const haystack = entry.content.toLocaleLowerCase();
  let score = 0;
  for (const term of queryProbes.lexical_terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  for (const term of queryProbes.expanded_terms) {
    if (haystack.includes(term)) {
      score += 0.5;
    }
  }
  return score;
}

function selectDominantSurfaceId(
  footholds: readonly Readonly<MemoryEntry>[]
): string | null {
  const counts = new Map<string, number>();
  for (const entry of footholds) {
    if (entry.surface_id !== null) {
      counts.set(entry.surface_id, (counts.get(entry.surface_id) ?? 0) + 1);
    }
  }
  let best: { readonly surfaceId: string; readonly count: number } | null = null;
  for (const [surfaceId, count] of counts) {
    if (best === null || count > best.count) {
      best = { surfaceId, count };
    }
  }
  if (best === null) {
    return null;
  }
  return best.count / footholds.length > SESSION_ROUTE_DOMINANCE_RATIO ? best.surfaceId : null;
}
