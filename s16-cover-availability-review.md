# S16 cover availability review

## Summary

The live Select_Gamma bind is a general producer→consumer classification, not a miss-ID or weight retune. Production `bindFineAssessmentBindingCover` always passes `obligation.values_status` and facet count; unavailable OSF still cannot attribute value receipts (`attributeCandidateBindingCoverage` returns an empty map when composition is unusable), so HEAD numerics hold on the production walk: known-zero and unavailable both score `fused_score − rho`, and only positive increment uses `quality + coverGain − rho`. Query-level `cover_evidence` is materialized on the selected-set receipt; truncated OSF is available; no bounded-quality constant; no fusion/RRF/flood change.

`SelectedBindingSetReceipt.cover_evidence` is required with `schema_version: 1`. The only constructor is `materializeSelectedBindingSetReceipt`. No protocol/zod parser, fixture object, or selection-boundary expected digest includes this type, so the new field does not break existing parsers. Replay re-runs selection.

The planted live path (`selectFineAssessmentCandidates`) distinguishes unavailable vs known-zero on the receipt (`cover_evidence` / `values_status`) while preserving S14 ranking keys. Per-candidate `cover_availability` is asserted on a helper-built objective, which is the only surface that emits that field (`decomposeGain`); displacement still keys off `coverage`/`quality` only.

Issues below are helper-contract and layering gaps, not live ranking defects.

## Checks

- Production bind supplies status: `packages/core/src/recall/delivery/select-gamma/binding-cover/production.ts:55`.
- Other `createBindingAwareWalkObjective` callers: production plus tests (`select-gamma-binding-cover.test.ts`, planted test). No other production caller.
- No ranking/fusion/RRF/flood retune; no miss-ID branch.
- Displacement (`admission/displacement.ts:62`) does not read `cover_availability`; with production `coverage === 0` on unavailable/known-zero this is equivalent.

## Issues

### Issue 1 -- Severity: suggestion
- **File**: packages/core/src/recall/delivery/select-gamma/binding-cover/objective.ts:32
- **Description**: `createBindingAwareWalkObjective` defaults omitted `valuesStatus` to `"observed"` (`obligationFacetCount` to `0`). That is fail-open: leftover receipts with a positive increment are treated as usable cover and labeled `positive` / `known_zero`, not `unavailable`. Production bind does not omit the field, so the live walk is safe. Unit helpers in `select-gamma-binding-cover.test.ts` (facility + Values_v at line 259, `bindingObjective` at line 493) rely on the default to keep cover increments. The named contract is that omitted production status must not impersonate usable cover; the helper API still does.
- **Suggestion**: Make `valuesStatus` required, or default it to `"unavailable"`. Pass `valuesStatus: "observed"` explicitly from the existing unit helpers that intend cover increments. Keep production as the source of obligation status.
- **Status**: fixed
- **Response**: `valuesStatus` is required on `createBindingAwareWalkObjective`. Cover-increment unit helpers now pass `valuesStatus: "observed"` (facility + Values_v, `bindingObjective`). The empty-receipt facility displacement helper passes `"unavailable"`. Production still supplies obligation status. `obligationFacetCount` stays optional and defaults to `0` (fail-closed).

### Issue 2 -- Severity: suggestion
- **File**: packages/core/src/recall/delivery/select-gamma/types.ts:1
- **Description**: `select-gamma/types.ts` was a dependency-free formula-types leaf. It now type-imports `CoverAvailability` from `binding-cover/composition.js`, so the generic `SelectGammaGainParts` layer depends on the binding-cover specialization. There is no runtime cycle (`import type` is erased; `composition.ts` does not import `types.ts`), but the dependency direction is inverted. Optional `cover_availability` is otherwise the right shape: `walk-objective.ts` can still return quality/coverage only.
- **Suggestion**: Hoist `CoverAvailability` next to `SelectGammaGainParts` in `types.ts` (or a sibling shared module that both `types.ts` and `composition.ts` import). Keep `resolveCoverAvailability` in `composition.ts` as the single classifier.
- **Status**: fixed
- **Response**: `CoverAvailability` now lives next to `SelectGammaGainParts` in `select-gamma/types.ts`. `types.ts` no longer imports `composition.ts`. `composition.ts` imports the type from `../types.js` and re-exports it; `resolveCoverAvailability` remains the single classifier. `CoverEvidence` stays in `composition.ts` for the selected-set receipt.

### Issue 3 -- Severity: suggestion
- **File**: packages/core/src/__tests__/recall/delivery/select-gamma-cover-availability.planted.test.ts:138
- **Description**: The leftover-receipts planted case uses an empty `values` array, so `coverGain` is 0. Both HEAD (`coverGain <= 0 → rankingScore`) and the new branch (`unavailable → rankingScore`) yield `0.9`; the facility term `99` never runs. The only numeric fork versus HEAD is leftover *valued* receipts under `valuesStatus: "unavailable"` and `obligationFacetCount === 0` (`coverGain > 0` used to take `quality + cover`). Production cannot currently build that state (`candidate-receipt.ts` emits no receipt when composition is unusable). Related: `decomposeBindingGain` still reports raw `coverage` when `cover_availability === "unavailable"` (`objective.ts:116`). `classifyDisplacement` keys off `coverage >` and `quality <=` (`displacement.ts:62`), so a leftover valued receipt could be receipted as `coverage_displaced` even though gain used ranking.
- **Suggestion**: Plant a valued leftover receipt (and a high facility/quality term) under unavailable cover and assert ranking-only gain. If leftover cover must not count as cover, zero `coverage` in `decomposeGain` when availability is `unavailable`, or have displacement ignore coverage unless `cover_availability === "positive"`.
- **Status**: fixed
- **Response**: Planted a leftover *valued* receipt under `valuesStatus: "unavailable"` and `obligationFacetCount === 0` with facility term 99. Gain stays ranking-only (`0.9`), not `quality + cover`. `decomposeGain` now reports `coverage: 0` when `cover_availability === "unavailable"`, so displacement cannot treat leftover increment as `coverage_displaced`. Production ranking is unchanged: unusable composition still yields empty receipts.

## Implementation Summary

Made `valuesStatus` required on the binding-aware walk (no `"observed"` default). Hoisted `CoverAvailability` to `select-gamma/types.ts` so that file no longer imports `binding-cover/composition.ts`; `resolveCoverAvailability` remains the classifier. Unavailable `decomposeGain.coverage` is now `0`, and a planted valued leftover receipt asserts ranking-only gain. Tests 20/20; `pnpm --filter @do-soul/alaya-core build` passed.
