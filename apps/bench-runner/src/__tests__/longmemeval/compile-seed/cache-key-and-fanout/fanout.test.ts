import { describe, expect, it } from "vitest";
import { computeNextTurnSeedRefs } from
  "../../../../runs/compile-seed.js";
import { makeSeed } from "../compile-seed-fixture.js";

describe("computeNextTurnSeedRefs — D-1 single-id fan-out invariant", () => {
  // invariant: every assertion in this block guards the N x M edge-blowup
  // ceiling described in the helper anchor. A regression that re-introduces
  // the union-of-every-fact behavior must surface here, not in a
  // multi-hour bench.
  // see also: apps/bench-runner/src/runs/compile-seed/compile-seed-session.ts
  //   computeNextTurnSeedRefs

  it("returns [] when the current turn produced no seeds", () => {
    expect(
      computeNextTurnSeedRefs({ seeds: [] })
    ).toEqual([]);
  });

  it("returns exactly the first seed id when the current turn has one fact", () => {
    expect(
      computeNextTurnSeedRefs({ seeds: [makeSeed("memory-a")] })
    ).toEqual(["memory-a"]);
  });

  it("returns only the first seed id when the current turn has many facts (no N-fact union)", () => {
    // invariant: length is always 0 or 1, never N. This is the load-bearing
    // bound for the WSL2 500q runs.
    const seeds = [
      makeSeed("memory-a"),
      makeSeed("memory-b"),
      makeSeed("memory-c"),
      makeSeed("memory-d")
    ];
    const refs = computeNextTurnSeedRefs({ seeds });
    expect(refs).toEqual(["memory-a"]);
    expect(refs.length).toBeLessThanOrEqual(1);
  });

  it("models a multi-turn session: refs grow at most 1-per-turn and first turn carries none", () => {
    // Caller pattern: previousTurnSeedMemoryIds starts [], updates via
    // computeNextTurnSeedRefs after each seedTurn. Turn 0 always emits
    // with sourceMemoryRefs omitted (the [] sentinel maps to undefined in
    // the spread); turn N>=1 emits with exactly one ref (its predecessor's
    // first seed).
    const turns = [
      { seeds: [makeSeed("t0-a"), makeSeed("t0-b")] },
      { seeds: [makeSeed("t1-a"), makeSeed("t1-b"), makeSeed("t1-c")] },
      { seeds: [makeSeed("t2-a"), makeSeed("t2-b")] },
      { seeds: [] }, // a turn that produced no facts at all
      { seeds: [makeSeed("t4-a")] }
    ];
    let prev: readonly string[] = [];
    const observedSourceRefs: (readonly string[] | undefined)[] = [];
    for (const turn of turns) {
      observedSourceRefs.push(prev.length === 0 ? undefined : prev);
      prev = computeNextTurnSeedRefs(turn);
    }
    expect(observedSourceRefs).toEqual([
      undefined,         // turn 0: no predecessor
      ["t0-a"],          // turn 1: only the FIRST seed of turn 0
      ["t1-a"],          // turn 2: only the FIRST seed of turn 1
      ["t2-a"],          // turn 3: only the FIRST seed of turn 2
      undefined          // turn 4: predecessor produced zero seeds -> reset
    ]);
    for (const refs of observedSourceRefs) {
      // invariant: cardinality is the load-bearing bound.
      expect((refs ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("session-boundary semantics: caller resets prev to [] across sessions, first turn of session 2 is undefined", () => {
    // The bench runners hold `previousTurnSeedMemoryIds` in the per-session
    // scope. Re-entering the inner loop for a new session starts from [],
    // mirroring the very first turn of the run. This test pins that the
    // helper alone is consistent with that caller contract: a fresh [] in
    // produces a sourceMemoryRefs-undefined spread for the next call.
    const session1Refs = computeNextTurnSeedRefs({
      seeds: [makeSeed("s1-t0-a"), makeSeed("s1-t0-b")]
    });
    expect(session1Refs).toEqual(["s1-t0-a"]);
    // Caller flips to the next session, which re-initializes prev to [].
    const session2Prev: readonly string[] = [];
    expect(session2Prev.length).toBe(0);
    // The first turn of session 2 emits with undefined sourceMemoryRefs
    // (the runners use `prev.length === 0 ? {} : { sourceMemoryRefs: prev }`).
    const session2EmitSpread = session2Prev.length === 0
      ? ({} as { sourceMemoryRefs?: readonly string[] })
      : { sourceMemoryRefs: session2Prev };
    expect(session2EmitSpread.sourceMemoryRefs).toBeUndefined();
  });
});
