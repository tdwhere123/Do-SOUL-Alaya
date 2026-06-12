import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { runSelfBench } from "../../self/runner.js";
import { SYNTHETIC_SCENARIOS } from "../../self/scenarios.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "self-bench-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Self bench runner", () => {
  it(
    "runs all 8 synthetic scenarios with distractors through the real MCP chain and produces a valid kpi.json",
    async () => {
      const historyRoot = join(tmpDir, "history");

      const result = await runSelfBench({ historyRoot });

      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/);

      // harness_mode must reflect the real MCP chain, never direct_db_seed.
      expect(result.payload.harness_mode).toBe("mcp_propose_review");

      // All 8 scenarios must produce a per_scenario row
      expect(result.payload.kpi.per_scenario).toHaveLength(SYNTHETIC_SCENARIOS.length);
      expect(result.payload.kpi.per_scenario.length).toBe(8);

      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);

      expect(result.payload.bench_name).toBe("self");
      expect(result.payload.split).toBe("synthetic");

      const kpi = result.payload.kpi;
      expect(kpi.r_at_1).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_1).toBeLessThanOrEqual(1);
      expect(kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(kpi.r_at_10).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_10).toBeLessThanOrEqual(1);

      const tierTotal = kpi.tier_distribution.hot + kpi.tier_distribution.warm + kpi.tier_distribution.cold;
      expect(tierTotal).toBe(SYNTHETIC_SCENARIOS.length);

      const degradeTotal =
        kpi.degradation_reasons.none +
        kpi.degradation_reasons.warm_cascade_engaged +
        kpi.degradation_reasons.cold_cascade_engaged +
        kpi.degradation_reasons.recall_explainability_partial;
      expect(degradeTotal).toBe(SYNTHETIC_SCENARIOS.length);

      const expectedIds = SYNTHETIC_SCENARIOS.map((s) => s.id);
      const actualIds = result.payload.kpi.per_scenario.map((r) => r.id);
      expect(actualIds).toEqual(expectedIds);

      // Distractor-pressure check: with 3-5 unrelated memories seeded
      // alongside each scenario's 1-2 setup utterances, the scoring is
      // no longer a tautology. The exact R@K depends on the daemon's
      // recall ranking against the FTS-derived scores; the values are
      // bounded in [0, 1] (already asserted above). R@K of 0 means the
      // recall did not surface the seeded setup above distractors;
      // that is real recall behavior on a 5–7-memory workspace, not a
      // harness bug. Surface the values so reviewers can see them.
      // eslint-disable-next-line no-console
      console.log(
        `[self-bench distractor pressure] r_at_1=${kpi.r_at_1} r_at_5=${kpi.r_at_5} r_at_10=${kpi.r_at_10} tier_hot=${kpi.tier_distribution.hot} tier_warm=${kpi.tier_distribution.warm} tier_cold=${kpi.tier_distribution.cold} degrade_none=${kpi.degradation_reasons.none} degrade_warm=${kpi.degradation_reasons.warm_cascade_engaged} degrade_cold=${kpi.degradation_reasons.cold_cascade_engaged}`
      );
    },
    240_000
  );
});
