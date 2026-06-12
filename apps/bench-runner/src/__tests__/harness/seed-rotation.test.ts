import { describe, expect, it } from "vitest";
import {
  BENCH_SEED_ROTATION,
  canonicalizeSeedObjectKind,
  rotatingSeedObjectKind,
  type SeedObjectKind
} from "../../harness/seed-rotation.js";

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
  // see also: packages/soul/src/garden/materialization-router/inputs.ts
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

describe("canonicalizeSeedObjectKind", () => {
  // invariant: routeByObjectKind only mints a memory_entry for its
  // enumerated dimension table. Any other object_kind on a high-confidence
  // potential_claim / potential_preference signal routes to evidence_only
  // (no memory_entry). The bench seed needs a durable memory_entry per turn
  // fact, so a free-form extracted kind must be canonicalized.
  // see also: packages/soul/src/garden/materialization-router/inputs.ts
  //   routeByObjectKind
  it("maps a free-form extracted object_kind onto the fact route", () => {
    for (const freeForm of [
      "travel_itinerary",
      "health_advice",
      "podcast",
      "landmark",
      "user_preference",
      "concept",
      "lesson plan"
    ]) {
      expect(canonicalizeSeedObjectKind(freeForm)).toBe("fact");
    }
  });

  it("keeps a kind that already routes to a memory_entry verbatim", () => {
    for (const routed of [
      "preference",
      "decision",
      "constraint",
      "procedure",
      "hazard",
      "factual_policy",
      "exception",
      "glossary",
      "episode",
      "outcome",
      "reference",
      "task_state",
      "fact"
    ]) {
      expect(canonicalizeSeedObjectKind(routed)).toBe(routed);
    }
  });

  it("normalizes case and surrounding whitespace before matching", () => {
    expect(canonicalizeSeedObjectKind("  Preference  ")).toBe("preference");
    expect(canonicalizeSeedObjectKind("DECISION")).toBe("decision");
  });
});
