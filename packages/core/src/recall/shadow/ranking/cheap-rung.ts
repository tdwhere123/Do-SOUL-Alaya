import { prefixSK } from "../walk.js";
import {
  evaluateFirstPickTailDegeneracy,
  type DeterministicTailPickEvidence,
  type FirstPickTailDegeneracyReport
} from "./tail-degeneracy.js";

export const CHEAP_RANKING_RUNG_ID = "cheap_ranking_rung.v1" as const;
export const CHEAP_RANKING_RUNG_K = 5 as const;
export const CHEAP_RANKING_RUNG_COST = "in-process, no snapshot" as const;

export type CheapRankingRungRow = Readonly<{
  readonly question_id: string;
  readonly any_at_5: boolean;
  readonly first_pick: DeterministicTailPickEvidence | null;
}>;

export type CheapRankingRungRate = Readonly<{
  readonly hits: number;
  readonly denominator: number;
  readonly rate: number;
}>;

export type CheapRankingRungTailShare = Readonly<{
  readonly tail_decided: number;
  readonly denominator: number;
  readonly share: number;
}>;

export type CheapRankingRungReport = Readonly<{
  readonly rung_id: typeof CHEAP_RANKING_RUNG_ID;
  readonly k: typeof CHEAP_RANKING_RUNG_K;
  readonly cost: typeof CHEAP_RANKING_RUNG_COST;
  readonly questions: number;
  readonly any_at_5: CheapRankingRungRate;
  readonly tail_share: CheapRankingRungTailShare;
  readonly degeneracy: FirstPickTailDegeneracyReport;
}>;

export function cheapRungAnyAt5(
  goldCandidateKeys: readonly string[],
  selectedKeys: readonly string[],
  k: number = CHEAP_RANKING_RUNG_K
): boolean {
  const prefix = prefixSK(selectedKeys, k);
  return goldCandidateKeys.some((key) => prefix.includes(key));
}

export function scoreCheapRankingRung(
  rows: readonly CheapRankingRungRow[]
): CheapRankingRungReport {
  const firstPicks: DeterministicTailPickEvidence[] = [];
  for (const row of rows) {
    if (row.first_pick !== null) firstPicks.push(row.first_pick);
  }
  const degeneracy = evaluateFirstPickTailDegeneracy(firstPicks);
  const hits = rows.reduce((count, row) => count + (row.any_at_5 ? 1 : 0), 0);
  return {
    rung_id: CHEAP_RANKING_RUNG_ID,
    k: CHEAP_RANKING_RUNG_K,
    cost: CHEAP_RANKING_RUNG_COST,
    questions: rows.length,
    any_at_5: rate(hits, rows.length),
    tail_share: {
      tail_decided: degeneracy.tail_decided_count,
      denominator: degeneracy.first_pick_count,
      share: degeneracy.share
    },
    degeneracy
  };
}

function rate(hits: number, denominator: number): CheapRankingRungRate {
  return {
    hits,
    denominator,
    rate: denominator === 0 ? 0 : hits / denominator
  };
}
