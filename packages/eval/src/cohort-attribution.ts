import { z } from "zod";

// Pure aggregation helper for per-plane attribution of recall hits in
// LongMemEval / cross-question / multi-turn diagnostics sidecars.
//
// invariant: a plane "wins" attribution for a gold delivery iff it is
// the `plane_winning_admission` recorded on the diagnostic row. The
// share metric is therefore a function of the diagnostics file alone;
// it does not touch trust state, PathRelation, or any storage.
//
// Why this matters: when one admission plane dominates (e.g.
// session_surface_cohort wins >50% of hits) the recall stack has
// degenerated to single-plane dependence. The remaining planes are
// inert. The aggregate R@K can still look healthy while the plane
// budget is silently collapsing. This helper exposes that collapse so
// release diff docs can call it out.
//
// see also: shareOfPlane() below — bench-diff doc surfaces consume
// the cohort share returned here as a recall-stack collapse gate.

export const PlaneAttributionRowSchema = z
  .object({
    // Question id — diagnostics sidecar uses `question_id`.
    question_id: z.string().min(1),
    hit_at_5: z.boolean(),
    // Winning admission plane for the first gold pointer that landed
    // in the delivered top-K. `null` when the question was a miss
    // (no gold delivery to attribute) or when the diagnostic row
    // omitted the field (older sidecars).
    plane_winning_admission: z.string().min(1).nullable()
  })
  .readonly();

export type PlaneAttributionRow = z.infer<typeof PlaneAttributionRowSchema>;

export interface PlaneAttributionShare {
  readonly plane: string;
  readonly hits: number;
  readonly share: number;
}

export interface PlaneAttributionResult {
  readonly total_hits: number;
  readonly attributed_hits: number;
  readonly unattributed_hits: number;
  readonly shares: readonly PlaneAttributionShare[];
}

// Roll up per-plane attribution shares from a flat list of diagnostic
// rows. Only `hit_at_5 === true` rows participate; misses have no plane
// to attribute. `unattributed_hits` counts hits whose
// `plane_winning_admission` is null (diagnostic gap, not a plane).
//
// invariant: sum(shares[*].hits) + unattributed_hits === attributed_hits + unattributed_hits === total_hits
// where shares are sorted by hits descending then plane name ascending
// for stable diffs.
export function computePlaneAttribution(
  rows: readonly PlaneAttributionRow[]
): PlaneAttributionResult {
  const hits = rows.filter((r) => r.hit_at_5);
  const totalHits = hits.length;

  const byPlane = new Map<string, number>();
  let unattributed = 0;
  for (const row of hits) {
    if (row.plane_winning_admission === null) {
      unattributed += 1;
      continue;
    }
    byPlane.set(
      row.plane_winning_admission,
      (byPlane.get(row.plane_winning_admission) ?? 0) + 1
    );
  }

  const shares: PlaneAttributionShare[] = [];
  for (const [plane, count] of byPlane) {
    shares.push({
      plane,
      hits: count,
      share: totalHits === 0 ? 0 : count / totalHits
    });
  }
  shares.sort((a, b) => {
    if (a.hits !== b.hits) return b.hits - a.hits;
    return a.plane.localeCompare(b.plane);
  });

  return Object.freeze({
    total_hits: totalHits,
    attributed_hits: totalHits - unattributed,
    unattributed_hits: unattributed,
    shares: Object.freeze(shares)
  });
}

// Pull the rows-of-interest out of a LongMemEval / cross-question
// diagnostics sidecar. The sidecar shape evolves over time; this
// extractor tolerates rows that omit `plane_winning_admission` by
// reaching into the per-gold `gold[*].plane_winning_admission` field
// (older sidecars only carry the plane on the gold sub-record).
//
// invariant: at most one row emitted per question — the first gold
// delivery that landed in the top-K determines attribution, matching
// the runner's `hit_at_5` semantics (any gold in top-5 counts the
// question as a hit).
export function extractPlaneAttributionRows(
  questions: readonly unknown[]
): readonly PlaneAttributionRow[] {
  const rows: PlaneAttributionRow[] = [];
  for (const raw of questions) {
    if (raw === null || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.question_id !== "string") continue;
    const hitAt5 = q.hit_at_5 === true;
    const plane = pickWinningPlane(q);
    rows.push({
      question_id: q.question_id,
      hit_at_5: hitAt5,
      plane_winning_admission: plane
    });
  }
  return Object.freeze(rows);
}

function pickWinningPlane(question: Record<string, unknown>): string | null {
  if (typeof question.plane_winning_admission === "string") {
    return question.plane_winning_admission;
  }
  if (Array.isArray(question.gold)) {
    for (const goldRaw of question.gold) {
      if (goldRaw === null || typeof goldRaw !== "object") continue;
      const gold = goldRaw as Record<string, unknown>;
      if (gold.candidate_status !== "delivered") continue;
      const rank = typeof gold.final_rank === "number" ? gold.final_rank : null;
      if (rank === null || rank > 5) continue;
      if (typeof gold.plane_winning_admission === "string") {
        return gold.plane_winning_admission;
      }
    }
  }
  return null;
}

// Convenience: pull the share for one specific plane (e.g.
// "session_surface_cohort") off the result. Returns 0 when the plane
// is absent — absence and zero are equivalent for the gate ("plane did
// not win any question").
export function shareOfPlane(
  result: PlaneAttributionResult,
  plane: string
): number {
  for (const row of result.shares) {
    if (row.plane === plane) return row.share;
  }
  return 0;
}
