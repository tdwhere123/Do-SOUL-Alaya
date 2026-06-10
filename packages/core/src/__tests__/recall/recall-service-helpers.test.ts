import { describe, expect, it } from "vitest";
import {
  BankruptcyKind,
  RuntimeMode,
  type BudgetSnapshot
} from "@do-soul/alaya-protocol";
import {
  assertActivationWeightsSumToOne,
  estimateTokens,
  mapBudgetPenalty,
  resolveActivationWeights
} from "../../recall-service-helpers.js";
import { makeTokenEstimator } from "../../recall-service-types.js";

function snapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    snapshot_at: "2026-05-11T00:00:00.000Z",
    run_id: "run-1",
    current_mode: RuntimeMode.FULL,
    bankruptcy_kind: BankruptcyKind.NONE,
    pressure_ratio: 0,
    trigger_summary: null,
    active_dossier: null,
    pending_proposal: null,
    ...overrides
  };
}

describe("recall service helpers", () => {
  it("maps budget pressure to a graduated monotonic penalty", () => {
    const points = [
      mapBudgetPenalty(snapshot({ bankruptcy_kind: BankruptcyKind.NONE, pressure_ratio: 0 })),
      mapBudgetPenalty(snapshot({ bankruptcy_kind: BankruptcyKind.NONE, pressure_ratio: 0.4 })),
      mapBudgetPenalty(snapshot({ bankruptcy_kind: BankruptcyKind.SOFT, pressure_ratio: 0.6 })),
      mapBudgetPenalty(snapshot({ bankruptcy_kind: BankruptcyKind.SOFT, pressure_ratio: 0.85 })),
      mapBudgetPenalty(snapshot({ bankruptcy_kind: BankruptcyKind.HARD, pressure_ratio: 1 }))
    ];

    expect(points[0]).toBe(0);
    expect(points[1]).toBe(0);
    expect(points[2]).toBeCloseTo(0.22, 10);
    expect(points[3]).toBeCloseTo(0.52, 10);
    expect(points[4]).toBe(1);
    expect(points).toEqual([...points].sort((left, right) => left - right));
  });

  it("keeps token estimation fallback byte-identical and lets per-call hints vary it", () => {
    const text = "x".repeat(101);

    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
    expect(estimateTokens(text, makeTokenEstimator({ hint: "approx_chars_per_token" }))).toBe(
      Math.ceil(text.length / 4)
    );
    expect(estimateTokens(text, makeTokenEstimator({ hint: "cl100k" }))).toBe(Math.ceil(text.length / 3.6));
    expect(estimateTokens(text, makeTokenEstimator({ hint: "o200k" }))).toBe(Math.ceil(text.length / 3.2));
  });

  it("resolves partial activation weight patches before checking sum-to-one", () => {
    const resolved = resolveActivationWeights({
      scope_match: 0.08,
      relevance: 0.2
    });

    expect(resolved).toMatchObject({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(() => assertActivationWeightsSumToOne(resolved)).not.toThrow();
    expect(() => assertActivationWeightsSumToOne({ relevance: 0.2 })).toThrow();
  });
});
