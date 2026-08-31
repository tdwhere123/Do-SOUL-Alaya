import {
  mergeFtsLanes,
  rankFtsLaneRows,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import { buildMonotoneFieldRefinementLevels } from
  "../../../shared/monotone-field-refinement.js";

export interface SynthesisCapsuleKeywordHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

export type SynthesisLaneReceipt = Readonly<{
  readonly lane: "exact" | "porter" | "trigram";
  readonly status: "complete" | "truncated" | "unavailable" | "ineligible";
  readonly depth: number;
  readonly observations: readonly Readonly<{
    readonly object_id: string;
    readonly rank: number;
    readonly normalized_rank: number;
    readonly source_id?: string;
  }>[];
  readonly unseen_upper_bound: number | null;
}>;

export type SynthesisKeywordFieldResult = Readonly<{
  readonly matches: readonly Readonly<SynthesisCapsuleKeywordHit>[];
  readonly lanes: readonly Readonly<SynthesisLaneReceipt>[];
  readonly refinement_levels?: readonly Readonly<{
    readonly requested_depth: number;
    readonly matches: readonly Readonly<SynthesisCapsuleKeywordHit>[];
    readonly lanes: readonly Readonly<SynthesisLaneReceipt>[];
  }>[];
}>;

export function buildSynthesisFieldView(
  rows: Readonly<{
    readonly porter: readonly FtsLaneRankRow[];
    readonly trigram: readonly FtsLaneRankRow[];
  }>,
  depth: number,
  porterEligible: boolean,
  trigramEligible: boolean
) {
  const porterHits = rankFtsLaneRows(rows.porter.slice(0, depth));
  const trigramHits = rankFtsLaneRows(rows.trigram.slice(0, depth));
  return Object.freeze({
    matches: mergeFtsLanes(porterHits, trigramHits, depth),
    lanes: Object.freeze([
      ineligibleSynthesisLane("exact"),
      buildSynthesisLane("porter", porterHits, depth, porterEligible),
      buildSynthesisLane("trigram", trigramHits, depth, trigramEligible)
    ])
  });
}

export function buildSynthesisFieldRefinementLevels(
  rows: Readonly<{
    readonly porter: readonly FtsLaneRankRow[];
    readonly trigram: readonly FtsLaneRankRow[];
  }>,
  baseMatches: readonly Readonly<SynthesisCapsuleKeywordHit>[],
  depths: readonly number[],
  porterEligible: boolean,
  trigramEligible: boolean
): NonNullable<SynthesisKeywordFieldResult["refinement_levels"]> {
  return buildMonotoneFieldRefinementLevels(
    baseMatches,
    depths,
    (depth) => buildSynthesisFieldView(rows, depth, porterEligible, trigramEligible)
  );
}

export function normalizeSynthesisRefinementDepths(
  baseDepth: number,
  depths: readonly number[]
): readonly number[] {
  const normalized = [...new Set(depths)].sort((left, right) => left - right);
  if (normalized.some((depth) => !Number.isSafeInteger(depth) || depth <= baseDepth)) {
    throw new RangeError("field refinement depths must be increasing above the base depth");
  }
  return Object.freeze(normalized);
}

export function ineligibleSynthesisField(): Readonly<SynthesisKeywordFieldResult> {
  return Object.freeze({
    matches: Object.freeze([]),
    lanes: Object.freeze([
      ineligibleSynthesisLane("exact"),
      ineligibleSynthesisLane("porter"),
      ineligibleSynthesisLane("trigram")
    ])
  });
}

function buildSynthesisLane(
  lane: "porter" | "trigram",
  rows: readonly Readonly<SynthesisCapsuleKeywordHit>[],
  limit: number,
  eligible: boolean
): Readonly<SynthesisLaneReceipt> {
  if (!eligible) return ineligibleSynthesisLane(lane);
  const truncated = rows.length >= limit;
  const observations = Object.freeze(rows.slice(0, limit).map((row, index) => Object.freeze({
    object_id: row.object_id,
    rank: index + 1,
    normalized_rank: row.normalized_rank,
    source_id: `synthesis:${lane}:${row.object_id}`
  })));
  return Object.freeze({
    lane,
    status: truncated ? "truncated" as const : "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: truncated ? 1 : 0
  });
}

function ineligibleSynthesisLane(lane: "exact" | "porter" | "trigram") {
  return Object.freeze({
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}
