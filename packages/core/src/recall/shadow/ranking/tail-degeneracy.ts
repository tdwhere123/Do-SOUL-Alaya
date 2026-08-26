import {
  deterministicTailDecidedThisPick,
  type DeterministicTailPickEvidence
} from "../walk.js";

export type { DeterministicTailPickEvidence };

// invariant: structural bound; not a 94Q KPI and not gold-selected
export const FIRST_PICK_TAIL_DECIDED_SHARE_MAX = 0.25;

export const FIRST_PICK_TAIL_DEGENERACY_PROPERTY =
  "first_pick_tail_decided_share_below_max" as const;

export type FirstPickTailDegeneracyReport = Readonly<{
  readonly property: typeof FIRST_PICK_TAIL_DEGENERACY_PROPERTY;
  readonly holds: boolean;
  readonly first_pick_count: number;
  readonly tail_decided_count: number;
  readonly share: number;
  readonly max_share: typeof FIRST_PICK_TAIL_DECIDED_SHARE_MAX;
}>;

type PickCounts = {
  first_pick_count: number;
  tail_decided_count: number;
};

export function evaluateFirstPickTailDegeneracy(
  picks: Iterable<DeterministicTailPickEvidence>
): FirstPickTailDegeneracyReport {
  const counts: PickCounts = { first_pick_count: 0, tail_decided_count: 0 };
  for (const pick of picks) addPick(counts, pick);
  return finishFirstPickTailDegeneracy(counts);
}

export async function evaluateFirstPickTailDegeneracyStream(
  picks: AsyncIterable<DeterministicTailPickEvidence>
): Promise<FirstPickTailDegeneracyReport> {
  const counts: PickCounts = { first_pick_count: 0, tail_decided_count: 0 };
  for await (const pick of picks) addPick(counts, pick);
  return finishFirstPickTailDegeneracy(counts);
}

function addPick(counts: PickCounts, pick: DeterministicTailPickEvidence): void {
  counts.first_pick_count += 1;
  if (deterministicTailDecidedThisPick(pick)) counts.tail_decided_count += 1;
}

function finishFirstPickTailDegeneracy(
  counts: PickCounts
): FirstPickTailDegeneracyReport {
  const share = counts.first_pick_count === 0
    ? 0
    : counts.tail_decided_count / counts.first_pick_count;
  return {
    property: FIRST_PICK_TAIL_DEGENERACY_PROPERTY,
    holds: counts.first_pick_count > 0 && share < FIRST_PICK_TAIL_DECIDED_SHARE_MAX,
    first_pick_count: counts.first_pick_count,
    tail_decided_count: counts.tail_decided_count,
    share,
    max_share: FIRST_PICK_TAIL_DECIDED_SHARE_MAX
  };
}
