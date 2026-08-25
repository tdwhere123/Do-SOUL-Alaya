# S16 cover availability

## Files changed

- `packages/core/src/recall/delivery/select-gamma/binding-cover/composition.ts`
  — `CoverAvailability`, `CoverEvidence`, `resolveCoverAvailability`, `resolveCoverEvidence`
- `packages/core/src/recall/delivery/select-gamma/binding-cover/objective.ts`
  — walk receives `valuesStatus` / `obligationFacetCount`; `bindingAwareGain` branches on cover availability; `decomposeGain` emits `cover_availability`
- `packages/core/src/recall/delivery/select-gamma/binding-cover/production.ts`
  — production objective is passed obligation `values_status` and facet count
- `packages/core/src/recall/delivery/select-gamma/binding-cover/selected-receipt.ts`
  — selected-set receipt carries query-level `cover_evidence`
- `packages/core/src/recall/delivery/select-gamma/binding-cover/types.ts`
  — `SelectedBindingSetReceipt.cover_evidence`
- `packages/core/src/recall/delivery/select-gamma/types.ts`
  — optional `SelectGammaGainParts.cover_availability`
- `packages/core/src/__tests__/recall/delivery/select-gamma-cover-availability.planted.test.ts`
  — planted falsifier (unavailable vs known-zero, positive cover, leftover empty receipts, truncated)
- `docs/handbook/recall.md`
  — live-path note, connectedness-matrix `Select_Gamma` row, S14 gain sentence

## Key decisions

- Cover evidence is available iff `values_status !== "unavailable"` or `obligation_facets.length > 0`. Truncated composed OSF is available, not unavailable.
- Per-candidate state: `unavailable` / `known_zero` / `positive`. Unavailable and known-zero both use `fused_score − rho`; only positive uses `quality + coverGain − rho`. Numerics match HEAD; the branch is now explicit and observable.
- Classification stays in `composition.ts` (no 11th `binding-cover/` sibling). `bindingAwareGain` applies the number; receipts remain the audit surface.
- `createBindingAwareWalkObjective` requires `valuesStatus`. Production supplies `obligation.values_status`. Unit helpers that intend cover increments pass `"observed"` explicitly.
- `SelectGammaGainParts.cover_availability` is optional so `walk-objective.ts` quality/coverage-only decompose is unchanged.

## Deviations

- None against the named repair. `docs/handbook/architecture.md` was left unchanged: it does not state the S14 zero-increment rule in one sentence that could be extended without becoming a dump.

## Verify

```bash
pnpm exec vitest run --project @do-soul/alaya-core \
  packages/core/src/__tests__/recall/delivery/select-gamma-cover-availability.planted.test.ts \
  packages/core/src/__tests__/recall/delivery/select-gamma-ranking-preserve.planted.test.ts \
  packages/core/src/__tests__/recall/delivery/select-gamma-binding-cover.test.ts
```

Result: **pass** — 3 files, 19 tests.

```bash
pnpm --filter @do-soul/alaya-core build
```

Result: **pass**.
