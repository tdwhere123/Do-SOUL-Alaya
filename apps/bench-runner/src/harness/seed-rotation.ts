// invariant: the bench harness diversifies seeded object_kinds so
// every archive exercises BOTH MaterializationRouter branches:
// memory_entry_only (fact / outcome / reference / task_state) AND
// memory_and_claim_draft (preference / decision / constraint /
// procedure / hazard / glossary / episode / factual_policy /
// exception). Bench archives produced after diversification are
// the live witness for derivePrecedenceBasis and the
// claim_status=draft lock; non-rotating seeders never exercise
// the claim_form persistence path.
// see also: packages/soul/src/garden/materialization-router.ts
//   routeByObjectKind
// see also: apps/bench-runner/src/harness/daemon.ts proposeMemory

export type SeedObjectKind =
  | "fact"
  | "preference"
  | "decision"
  | "constraint"
  | "outcome";

// invariant: 5-element rotation that covers both router branches:
// fact -> memory_entry_only
// preference -> memory_and_claim_draft
// decision -> memory_and_claim_draft
// constraint -> memory_and_claim_draft
// outcome -> memory_entry_only
// 3/5 = 60% claim-bearing, 2/5 = 40% memory-only. The choice keeps
// recall surface stable (memory_entry is persisted in both
// branches; recall delivers memory_entry rows only).
export const BENCH_SEED_ROTATION: readonly SeedObjectKind[] = Object.freeze([
  "fact",
  "preference",
  "decision",
  "constraint",
  "outcome"
]);

export function rotatingSeedObjectKind(seedIndex: number): SeedObjectKind {
  const len = BENCH_SEED_ROTATION.length;
  const idx = ((seedIndex % len) + len) % len;
  return BENCH_SEED_ROTATION[idx] as SeedObjectKind;
}
