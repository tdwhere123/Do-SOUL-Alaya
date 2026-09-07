import { describe, expect, it } from "vitest";
import { BankruptcyKind } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { mapBudgetPenalty } from "../../recall/runtime/recall-service-helpers.js";
import { createDependencies, createTaskSurface } from "./recall-service-test-fixtures.js";
import { requireAt } from "../helpers/defined.js";

describe("retained component contracts", () => {
it("maps budget pressure to a graduated monotonic penalty", () => {
    const baseSnapshot = {
      snapshot_at: "2026-05-11T00:00:00.000Z",
      run_id: "run-1",
      current_mode: "lean",
      trigger_summary: null,
      active_dossier: null,
      pending_proposal: null
    } as const;
    const ratios = [0, 0.5, 0.75, 0.99] as const;
    const penalties = ratios.map((pressure_ratio) =>
      mapBudgetPenalty({
        ...baseSnapshot,
        bankruptcy_kind: BankruptcyKind.SOFT,
        pressure_ratio
      })
    );

    expect(mapBudgetPenalty({ ...baseSnapshot, bankruptcy_kind: BankruptcyKind.NONE, pressure_ratio: 0 })).toBe(0);
    expect(mapBudgetPenalty({ ...baseSnapshot, bankruptcy_kind: BankruptcyKind.HARD, pressure_ratio: 1 })).toBe(1);
    expect(
      mapBudgetPenalty({
        ...baseSnapshot,
        bankruptcy_kind: BankruptcyKind.SOFT
      } as never)
    ).toBe(0);
    expect(penalties[0]).toBe(0);
    expect(penalties[1]).toBeCloseTo(0.1);
    expect(requireAt(penalties, 2)).toBeCloseTo(0.4);
    expect(requireAt(penalties, 3)).toBeGreaterThan(requireAt(penalties, 2));
  });

it("keeps the default keyword supplement enabled in default policy", () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);

    expect(service.buildDefaultPolicy("chat", createTaskSurface().runtime_id).coarse_filter.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
  });
});
