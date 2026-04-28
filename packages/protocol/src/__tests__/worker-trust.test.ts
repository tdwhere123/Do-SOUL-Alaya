import { describe, expect, it } from "vitest";
import {
  NarrativeBudgetConfigSchema,
  TrustAssessmentFactorSchema,
  WorkerTrustAssessmentSchema,
  WorkerTrustLevelSchema
} from "../worker-trust.js";

const validTimestamp = "2026-04-15T00:00:00.000Z";

describe("worker trust schemas", () => {
  it("parses a strict readonly trust assessment", () => {
    const assessment = WorkerTrustAssessmentSchema.parse({
      assessment_id: "assessment-1",
      worker_run_id: "worker-run-1",
      workspace_id: "workspace-1",
      trust_level: "standard",
      factors: ["governance_lease_active", "hard_constraints_present", "budget_within_limits"],
      factor_details: {
        governance_lease_active: "lease found",
        hard_constraints_present: "2 hard constraints"
      },
      assessed_at: validTimestamp
    });

    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.factors)).toBe(true);
    expect(assessment.trust_level).toBe("standard");
    expect(assessment.factors).toContain("budget_within_limits");
  });

  it("rejects invalid trust-level/factor names and non-strict payloads", () => {
    expect(() => WorkerTrustLevelSchema.parse("trusted")).toThrow();
    expect(() => TrustAssessmentFactorSchema.parse("budget_ok")).toThrow();

    expect(() =>
      WorkerTrustAssessmentSchema.parse({
        assessment_id: "assessment-1",
        worker_run_id: "worker-run-1",
        workspace_id: "workspace-1",
        trust_level: "high",
        factors: ["governance_lease_active"],
        assessed_at: validTimestamp,
        extra_field: true
      })
    ).toThrow();
  });
});

describe("narrative budget config schema", () => {
  it("parses a strict readonly budget config", () => {
    const config = NarrativeBudgetConfigSchema.parse({
      max_total_digest_bytes: 2048,
      max_digests_per_run: 8,
      consolidation_threshold_pct: 75
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(config.max_total_digest_bytes).toBe(2048);
  });

  it("rejects invalid bounds", () => {
    expect(() =>
      NarrativeBudgetConfigSchema.parse({
        max_total_digest_bytes: -1,
        max_digests_per_run: 8,
        consolidation_threshold_pct: 75
      })
    ).toThrow();

    expect(() =>
      NarrativeBudgetConfigSchema.parse({
        max_total_digest_bytes: 1024,
        max_digests_per_run: 8,
        consolidation_threshold_pct: 101
      })
    ).toThrow();
  });
});
