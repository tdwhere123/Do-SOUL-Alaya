import { describe, expect, it } from "vitest";
import {
  BENCH_CO_RECALL_HUB_FANOUT_CAP,
  planSessionCoRecallHub
} from "../harness/co-recall-hub.js";

describe("planSessionCoRecallHub", () => {
  it("returns null for fewer than two distinct members", () => {
    expect(planSessionCoRecallHub([])).toBeNull();
    expect(planSessionCoRecallHub(["only"])).toBeNull();
    // Duplicates collapse to one distinct member -> no co-occurrence to link.
    expect(planSessionCoRecallHub(["dup", "dup"])).toBeNull();
  });

  it("mints a HUB (members -> first-seeded representative), not a clique", () => {
    const plan = planSessionCoRecallHub(["m0", "m1", "m2", "m3"]);
    expect(plan).not.toBeNull();
    // Hub representative is the FIRST seeded member — session-deterministic,
    // never gold-derived (the plan receives only member ids in seed order).
    expect(plan!.representativeMemoryId).toBe("m0");
    // N members -> N-1 spokes (hub), not N*(N-1) (clique).
    expect(plan!.edges).toHaveLength(3);
    for (const edge of plan!.edges) {
      expect(edge.targetMemoryId).toBe("m0");
      expect(edge.sourceMemoryId).not.toBe("m0");
    }
    expect(plan!.edges.map((edge) => edge.sourceMemoryId)).toEqual([
      "m1",
      "m2",
      "m3"
    ]);
  });

  it("is session-deterministic in representative regardless of member order", () => {
    // The representative is positional (first element), so a caller that
    // happens to order the gold member first vs last changes which member is
    // the hub — but the choice is driven by seed POSITION, never by gold-ness.
    // This test pins the positional contract: first element wins.
    const goldFirst = planSessionCoRecallHub(["gold", "a", "b"]);
    const goldLast = planSessionCoRecallHub(["a", "b", "gold"]);
    expect(goldFirst!.representativeMemoryId).toBe("gold");
    expect(goldLast!.representativeMemoryId).toBe("a");
  });

  it("caps fanout at BENCH_CO_RECALL_HUB_FANOUT_CAP", () => {
    expect(BENCH_CO_RECALL_HUB_FANOUT_CAP).toBe(8);
    const members = Array.from({ length: 20 }, (_unused, index) => `m${index}`);
    const plan = planSessionCoRecallHub(members);
    expect(plan).not.toBeNull();
    expect(plan!.representativeMemoryId).toBe("m0");
    // Capped to 8 members linked to the hub -> 7 spokes (the hub itself is one
    // of the 8 capped members).
    expect(plan!.edges).toHaveLength(BENCH_CO_RECALL_HUB_FANOUT_CAP - 1);
    for (const edge of plan!.edges) {
      expect(edge.targetMemoryId).toBe("m0");
    }
    // No spoke escapes the cap window (m8..m19 are dropped).
    const linkedSources = new Set(plan!.edges.map((edge) => edge.sourceMemoryId));
    expect(linkedSources).toEqual(new Set(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]));
  });

  it("dedups duplicate member ids preserving first-seen order", () => {
    const plan = planSessionCoRecallHub(["a", "b", "a", "c", "b"]);
    expect(plan).not.toBeNull();
    expect(plan!.representativeMemoryId).toBe("a");
    expect(plan!.edges.map((edge) => edge.sourceMemoryId)).toEqual(["b", "c"]);
  });
});
