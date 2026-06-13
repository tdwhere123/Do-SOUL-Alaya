import { describe, expect, it } from "vitest";
import { BankruptcyKind, BudgetSnapshotSchema, RuntimeMode } from "../../index.js";

const baseSnapshot = {
  snapshot_at: "2026-05-11T00:00:00.000Z",
  run_id: "run-1",
  current_mode: RuntimeMode.FULL,
  bankruptcy_kind: BankruptcyKind.SOFT,
  trigger_summary: "Token estimate 1200 exceeds budget 800",
  active_dossier: null,
  pending_proposal: null
} as const;

describe("BudgetSnapshotSchema", () => {
  it("defaults pressure_ratio for old snapshots while accepting explicit producer values", () => {
    expect(BudgetSnapshotSchema.parse(baseSnapshot).pressure_ratio).toBe(0);
    expect(BudgetSnapshotSchema.parse({ ...baseSnapshot, pressure_ratio: 0.75 }).pressure_ratio).toBe(0.75);
  });

  it("rejects pressure_ratio outside [0, 1]", () => {
    expect(BudgetSnapshotSchema.safeParse({ ...baseSnapshot, pressure_ratio: -0.1 }).success).toBe(false);
    expect(BudgetSnapshotSchema.safeParse({ ...baseSnapshot, pressure_ratio: 1.1 }).success).toBe(false);
  });
});
