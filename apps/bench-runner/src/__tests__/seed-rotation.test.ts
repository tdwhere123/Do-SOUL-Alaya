import { describe, expect, it } from "vitest";
import {
  BENCH_SEED_ROTATION,
  rotatingSeedObjectKind,
  type SeedObjectKind
} from "../harness/seed-rotation.js";

describe("rotatingSeedObjectKind", () => {
  it("walks the 5-element rotation in order", () => {
    const observed: SeedObjectKind[] = [];
    for (let i = 0; i < BENCH_SEED_ROTATION.length; i += 1) {
      observed.push(rotatingSeedObjectKind(i));
    }
    expect(observed).toEqual([...BENCH_SEED_ROTATION]);
  });

  it("wraps around after the rotation length", () => {
    expect(rotatingSeedObjectKind(BENCH_SEED_ROTATION.length)).toBe(
      rotatingSeedObjectKind(0)
    );
    expect(rotatingSeedObjectKind(BENCH_SEED_ROTATION.length + 2)).toBe(
      rotatingSeedObjectKind(2)
    );
  });

  it("handles negative indices via modular arithmetic", () => {
    expect(rotatingSeedObjectKind(-1)).toBe(
      rotatingSeedObjectKind(BENCH_SEED_ROTATION.length - 1)
    );
  });

  // invariant: the rotation MUST cover both router branches. claim-
  // capable kinds (preference / decision / constraint) exercise
  // memory_and_claim_draft; fact / outcome exercise memory_entry_only.
  // see also: packages/soul/src/garden/materialization-router.ts
  it("includes at least one claim-capable kind and one memory-only kind", () => {
    const set = new Set<SeedObjectKind>(BENCH_SEED_ROTATION);
    const claimCapable: ReadonlySet<SeedObjectKind> = new Set([
      "preference",
      "decision",
      "constraint"
    ]);
    const memoryOnly: ReadonlySet<SeedObjectKind> = new Set(["fact", "outcome"]);
    const claimHits = [...claimCapable].filter((kind) => set.has(kind));
    const memoryHits = [...memoryOnly].filter((kind) => set.has(kind));
    expect(claimHits.length).toBeGreaterThan(0);
    expect(memoryHits.length).toBeGreaterThan(0);
  });
});
