import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { runSelfBench } from "../self/runner.js";
import { SYNTHETIC_SCENARIOS } from "../self/scenarios.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "self-bench-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Self bench runner", () => {
  it(
    "runs all 8 synthetic scenarios against a real in-process daemon and produces a valid kpi.json",
    async () => {
      const historyRoot = join(tmpDir, "history");

      const result = await runSelfBench({ historyRoot });

      // Slug format must match SLUG_PATTERN
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/);

      // All 8 scenarios must produce a per_scenario row
      expect(result.payload.kpi.per_scenario).toHaveLength(SYNTHETIC_SCENARIOS.length);
      expect(result.payload.kpi.per_scenario.length).toBe(8);

      // KPI payload must pass schema validation
      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);

      // Structural assertions
      expect(result.payload.bench_name).toBe("self");
      expect(result.payload.split).toBe("synthetic");

      const kpi = result.payload.kpi;
      // Rate values must be in [0, 1]
      expect(kpi.r_at_1).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_1).toBeLessThanOrEqual(1);
      expect(kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(kpi.r_at_10).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_10).toBeLessThanOrEqual(1);

      // Tier distribution must account for all scenarios
      const tierTotal = kpi.tier_distribution.hot + kpi.tier_distribution.warm + kpi.tier_distribution.cold;
      expect(tierTotal).toBe(SYNTHETIC_SCENARIOS.length);

      // Degradation reasons must account for all scenarios
      const degradeTotal =
        kpi.degradation_reasons.none +
        kpi.degradation_reasons.warm_cascade_engaged +
        kpi.degradation_reasons.cold_cascade_engaged;
      expect(degradeTotal).toBe(SYNTHETIC_SCENARIOS.length);

      // All per-scenario ids match the scenario definitions
      const expectedIds = SYNTHETIC_SCENARIOS.map((s) => s.id);
      const actualIds = result.payload.kpi.per_scenario.map((r) => r.id);
      expect(actualIds).toEqual(expectedIds);
    },
    90_000
  );
});
