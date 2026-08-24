import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { firstSelectGammaExclusionReason } from
  "../../../recall/delivery/select-gamma/admission/first-exclusion.js";
import { selectGammaWalk } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import type {
  SelectGammaWalkObjective
} from "../../../recall/delivery/select-gamma/types.js";
import { createSelectGammaGenericWalkObjective } from
  "../../../recall/delivery/select-gamma/walk-objective.js";
import { ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID } from
  "../../../recall/field/facility-objective.js";
import {
  facilityWalkObjective,
  frozenParityPool,
  PARITY_GOLDS,
  withSourceDedupe,
  type FrozenParityPool
} from "./select-gamma-parity-pool.js";

describe("Select_Gamma selector parity cells", () => {
  it("matches live walk keys and decision order on the generic proof path", () => {
    const pool = frozenParityPool();
    for (const sourceHardDedupe of [true, false] as const) {
      const binding = withSourceDedupe(pool.binding, sourceHardDedupe);
      const live = selectGammaWalk(pool.request, binding);
      const proof = selectGammaWalk(
        pool.request,
        binding,
        createSelectGammaGenericWalkObjective(binding.feature_weights)
      );
      expect(proof.selected_candidate_keys).toEqual(live.selected_candidate_keys);
      expect(proof.decisions.map(decisionKeys)).toEqual(
        live.decisions.map(decisionKeys)
      );
      expect(live.selection_receipt.objective_semantic_id)
        .toBe(SELECT_GAMMA_OPERATOR_ID);
      expect(live.selection_receipt.source_hard_dedupe).toBe(sourceHardDedupe);
    }
  });

  it("emits four-cell first-exclusion receipts on one frozen pool", () => {
    const pool = frozenParityPool();
    const generic = createSelectGammaGenericWalkObjective(pool.binding.feature_weights);
    const facility = facilityWalkObjective(pool);
    const cells = {
      generic_dedupe_on: runCell(pool, generic, true),
      generic_dedupe_off: runCell(pool, generic, false),
      facility_dedupe_on: runCell(pool, facility, true),
      facility_dedupe_off: runCell(pool, facility, false)
    };
    expectGenericCells(cells);
    expectFacilityCells(cells);
  });
});

function expectGenericCells(cells: FourCells): void {
  expect(cells.generic_dedupe_on).toEqual(cellSnapshot(
    ["gold-apple", "distractor-high", "gold-orange"],
    SELECT_GAMMA_OPERATOR_ID,
    null,
    true,
    {
      "gold-apple": null,
      "gold-banana": "duplicate_source",
      "gold-orange": null
    }
  ));
  expect(cells.generic_dedupe_off).toEqual(cellSnapshot(
    ["gold-apple", "gold-banana", "distractor-high"],
    SELECT_GAMMA_OPERATOR_ID,
    null,
    false,
    {
      "gold-apple": null,
      "gold-banana": null,
      "gold-orange": "quality_displaced"
    }
  ));
}

function expectFacilityCells(cells: FourCells): void {
  expect(cells.facility_dedupe_on.selection_receipt.objective_semantic_id)
    .toBe(ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID);
  expect(cells.facility_dedupe_off.selection_receipt.objective_semantic_id)
    .toBe(ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID);
  expect(cells.facility_dedupe_on.selected_keys).toEqual([
    "gold-apple", "gold-orange", "distractor-high"
  ]);
  expect(cells.facility_dedupe_on.gold_first_exclusion).toEqual({
    "gold-apple": null,
    "gold-banana": "duplicate_source",
    "gold-orange": null
  });
  expect(cells.facility_dedupe_off.selected_keys).toEqual([
    "gold-apple", "gold-orange", "gold-banana"
  ]);
  expect(cells.facility_dedupe_off.gold_first_exclusion).toEqual({
    "gold-apple": null,
    "gold-banana": null,
    "gold-orange": null
  });
  expect(cells.facility_dedupe_on.selection_receipt.configuration_digest)
    .toBe(cells.facility_dedupe_off.selection_receipt.configuration_digest);
  expect(cells.facility_dedupe_on.selection_receipt.configuration_digest)
    .toMatch(/^sha256:[0-9a-f]{64}$/u);
}

function runCell<State>(
  pool: FrozenParityPool,
  objective: SelectGammaWalkObjective<State>,
  sourceHardDedupe: boolean
) {
  const walk = selectGammaWalk(
    pool.request,
    withSourceDedupe(pool.binding, sourceHardDedupe),
    objective
  );
  return cellSnapshot(
    [...walk.selected_candidate_keys],
    walk.selection_receipt.objective_semantic_id,
    walk.selection_receipt.configuration_digest,
    walk.selection_receipt.source_hard_dedupe,
    Object.fromEntries(PARITY_GOLDS.map((gold) => [
      gold,
      firstSelectGammaExclusionReason(gold, walk)
    ])) as GoldFirstExclusion
  );
}

function cellSnapshot(
  selectedKeys: readonly string[],
  operatorId: string,
  configurationDigest: string | null,
  sourceHardDedupe: boolean,
  goldFirstExclusion: GoldFirstExclusion
) {
  return {
    selected_keys: selectedKeys,
    gold_first_exclusion: goldFirstExclusion,
    selection_receipt: {
      objective_semantic_id: operatorId,
      configuration_digest: configurationDigest,
      source_hard_dedupe: sourceHardDedupe
    }
  };
}

function decisionKeys(decision: Readonly<{
  readonly candidate_key: string;
  readonly selection_order: number;
  readonly selected_rank: number | null;
  readonly receipt: { readonly kind: string };
}>) {
  return Object.freeze({
    candidate_key: decision.candidate_key,
    selection_order: decision.selection_order,
    selected_rank: decision.selected_rank,
    receipt_kind: decision.receipt.kind
  });
}

type GoldFirstExclusion = Readonly<Record<
  (typeof PARITY_GOLDS)[number],
  ReturnType<typeof firstSelectGammaExclusionReason>
>>;

type Cell = ReturnType<typeof cellSnapshot>;

type FourCells = Readonly<{
  readonly generic_dedupe_on: Cell;
  readonly generic_dedupe_off: Cell;
  readonly facility_dedupe_on: Cell;
  readonly facility_dedupe_off: Cell;
}>;
