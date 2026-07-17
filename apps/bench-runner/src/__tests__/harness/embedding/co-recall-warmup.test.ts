import { describe, expect, it } from "vitest";
import {
  BENCH_CO_RECALL_WARMUP_PAIR_CAP,
  planSessionCoRecallWarmup
} from "../../../harness/embedding/co-recall-warmup.js";

const THRESHOLD = 3;

describe("planSessionCoRecallWarmup", () => {
  it("returns null for fewer than two distinct members", () => {
    expect(planSessionCoRecallWarmup([], THRESHOLD)).toBeNull();
    expect(planSessionCoRecallWarmup(["only"], THRESHOLD)).toBeNull();
    // Duplicates collapse to one distinct member -> no co-occurrence to earn.
    expect(planSessionCoRecallWarmup(["dup", "dup"], THRESHOLD)).toBeNull();
  });

  it("returns null for a non-positive-integer threshold", () => {
    expect(planSessionCoRecallWarmup(["a", "b"], 0)).toBeNull();
    expect(planSessionCoRecallWarmup(["a", "b"], -1)).toBeNull();
    expect(planSessionCoRecallWarmup(["a", "b"], 1.5)).toBeNull();
  });

  it("plans adjacent member pairs (a chain), not a hub or a clique", () => {
    const plan = planSessionCoRecallWarmup(["m0", "m1", "m2", "m3"], THRESHOLD);
    expect(plan).not.toBeNull();
    // Chain of adjacent pairs: (m0,m1),(m1,m2),(m2,m3) — N-1 candidate pairs,
    // each capped to BENCH_CO_RECALL_WARMUP_PAIR_CAP. With 4 members and cap 3
    // all 3 adjacent pairs are kept. A hub would point every member at m0; a
    // clique would be C(4,2)=6 pairs.
    expect(plan!.pairs).toEqual([
      { lowMemoryId: "m0", highMemoryId: "m1" },
      { lowMemoryId: "m1", highMemoryId: "m2" },
      { lowMemoryId: "m2", highMemoryId: "m3" }
    ]);
  });

  it("echoes the production threshold as the replay count", () => {
    const plan = planSessionCoRecallWarmup(["a", "b"], THRESHOLD);
    expect(plan!.replayCount).toBe(THRESHOLD);
  });

  it("caps the earned pair count FAR below a same-session hub/clique", () => {
    expect(BENCH_CO_RECALL_WARMUP_PAIR_CAP).toBe(3);
    const members = Array.from({ length: 20 }, (_unused, index) => `m${index}`);
    const plan = planSessionCoRecallWarmup(members, THRESHOLD);
    expect(plan).not.toBeNull();
    // Sparse: at most BENCH_CO_RECALL_WARMUP_PAIR_CAP pairs (3), vs a hub's
    // N-1=19 spokes or a clique's C(20,2)=190 edges. This is the sparseness
    // contract — earned co_recalled count per session « v1's N-1 saturation.
    expect(plan!.pairs).toHaveLength(BENCH_CO_RECALL_WARMUP_PAIR_CAP);
    expect(plan!.pairs).toEqual([
      { lowMemoryId: "m0", highMemoryId: "m1" },
      { lowMemoryId: "m1", highMemoryId: "m2" },
      { lowMemoryId: "m2", highMemoryId: "m3" }
    ]);
  });

  it("normalizes each pair to (low, high) to match the production counter key", () => {
    // accrueCoOccurrence sorts the pair before keying the durable counter; the
    // planner must emit the SAME (low, high) order so a replay accrues the
    // intended pair regardless of seed order. Here seed order is descending.
    const plan = planSessionCoRecallWarmup(["m9", "m1"], THRESHOLD);
    expect(plan!.pairs).toEqual([{ lowMemoryId: "m1", highMemoryId: "m9" }]);
  });

  it("is gold-blind: pair selection is positional, never answer-derived", () => {
    // The planner receives only member ids in seed order; placing the gold
    // member first vs last only changes which adjacent pairs it participates
    // in, never WHETHER it is selected. The selection is driven by seed
    // POSITION, never by gold-ness.
    const goldFirst = planSessionCoRecallWarmup(["gold", "a", "b"], THRESHOLD);
    const goldLast = planSessionCoRecallWarmup(["a", "b", "gold"], THRESHOLD);
    expect(goldFirst!.pairs).toEqual([
      { lowMemoryId: "a", highMemoryId: "gold" },
      { lowMemoryId: "a", highMemoryId: "b" }
    ]);
    expect(goldLast!.pairs).toEqual([
      { lowMemoryId: "a", highMemoryId: "b" },
      { lowMemoryId: "b", highMemoryId: "gold" }
    ]);
  });

  it("dedups duplicate member ids preserving first-seen order", () => {
    const plan = planSessionCoRecallWarmup(["a", "b", "a", "c", "b"], THRESHOLD);
    expect(plan).not.toBeNull();
    // Distinct members in first-seen order: a, b, c -> adjacent pairs (a,b),(b,c).
    expect(plan!.pairs).toEqual([
      { lowMemoryId: "a", highMemoryId: "b" },
      { lowMemoryId: "b", highMemoryId: "c" }
    ]);
  });
});
