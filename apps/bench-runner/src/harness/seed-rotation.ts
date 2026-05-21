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

// invariant: the production OfficialApiGardenProvider.compile LLM emits a
// free-form `object_kind` (travel_itinerary / health_advice / podcast / …)
// — it is NOT constrained to the MaterializationRouter's enumerated
// dimension table. routeByObjectKind only produces a memory_entry for the
// kinds it enumerates: the claim-capable dimensions
// (preference / decision / constraint / procedure / hazard / glossary /
// episode / factual_policy / exception) → memory_and_claim, and
// fact / outcome / reference / task_state → memory_entry_only. Any other
// kind on a high-confidence potential_claim / potential_preference signal
// routes to evidence_only — an evidence_capsule with NO memory_entry — so
// the bench seed (which needs a durable memory_entry per turn fact for
// recall scoring) silently loses the turn.
//
// The bench therefore canonicalizes an unrouted extracted object_kind onto
// `fact` (the memory_entry_only route — a memory_entry with no spurious
// draft claim_form). A kind that already routes to a memory_entry is kept
// verbatim so the archive still exercises both router branches. The
// original LLM-chosen kind is preserved by the caller in
// raw_payload.extracted_object_kind for audit fidelity.
// see also: packages/soul/src/garden/materialization-router.ts
//   routeByObjectKind
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts extractSeedInputs
const MEMORY_ENTRY_ROUTED_OBJECT_KINDS: ReadonlySet<string> = new Set([
  // routeByObjectKind → memory_and_claim (evidence + memory + claim)
  "preference",
  "decision",
  "constraint",
  "procedure",
  "hazard",
  "factual_policy",
  "exception",
  "glossary",
  "episode",
  // routeByObjectKind → memory_entry_only (evidence + memory, no claim)
  "outcome",
  "reference",
  "task_state",
  "fact"
]);

export function canonicalizeSeedObjectKind(extractedObjectKind: string): string {
  const normalized = extractedObjectKind.trim().toLowerCase();
  return MEMORY_ENTRY_ROUTED_OBJECT_KINDS.has(normalized)
    ? normalized
    : "fact";
}
