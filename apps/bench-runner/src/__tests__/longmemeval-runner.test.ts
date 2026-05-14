import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { runLongMemEval } from "../longmemeval/runner.js";
import type { LongMemEvalQuestion } from "../longmemeval/dataset.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildMockQuestion(id: string, answerSessionId: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What did the user say about topic ${id}?`,
    answer: `The answer for ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [answerSessionId, "decoy-session"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: `The correct fact about ${id} is stored here.`, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [
        { role: "user", content: "Unrelated conversation about cooking pasta." }
      ]
    ],
    answer_session_ids: [answerSessionId]
  };
}

describe("LongMemEval runner", () => {
  it(
    "runs 2-question mock dataset through the real MCP propose+review chain and produces a valid kpi.json with mcp_propose_review harness_mode",
    async () => {
      const dataDir = join(tmpDir, "longmemeval");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("q001", "session-a"),
        buildMockQuestion("q002", "session-b")
      ];

      const variant = "longmemeval_oracle";
      await writeFile(
        join(dataDir, `${variant}.json`),
        JSON.stringify(mockQuestions),
        "utf8"
      );
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: "test-sha256", questionCount: 2 }),
        "utf8"
      );

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir
      });

      // Slug format must match SLUG_PATTERN
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/);

      // harness_mode must reflect the real MCP chain — never direct_db_seed.
      expect(result.payload.harness_mode).toBe("mcp_propose_review");

      // KPI payload must pass schema validation
      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);

      // Structural assertions
      expect(result.payload.bench_name).toBe("public");
      expect(result.payload.split).toBe("longmemeval-s");
      expect(result.payload.kpi.per_scenario).toHaveLength(2);
      expect(result.payload.kpi.per_scenario[0]?.id).toBe("q001");
      expect(result.payload.kpi.per_scenario[1]?.id).toBe("q002");

      // All rate values are in [0, 1]
      const kpi = result.payload.kpi;
      expect(kpi.r_at_1).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_1).toBeLessThanOrEqual(1);
      expect(kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(kpi.r_at_10).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_10).toBeLessThanOrEqual(1);

      // Degradation reasons sum to the number of evaluated questions —
      // the values come from the daemon's recall response, not seed counts.
      const degradeTotal =
        kpi.degradation_reasons.none +
        kpi.degradation_reasons.warm_cascade_engaged +
        kpi.degradation_reasons.cold_cascade_engaged;
      expect(degradeTotal).toBe(2);

      // eslint-disable-next-line no-console
      console.log(
        `[longmemeval mock harness] r_at_1=${kpi.r_at_1} r_at_5=${kpi.r_at_5} r_at_10=${kpi.r_at_10} tier_hot=${kpi.tier_distribution.hot} tier_warm=${kpi.tier_distribution.warm} tier_cold=${kpi.tier_distribution.cold} degrade_none=${kpi.degradation_reasons.none} degrade_warm=${kpi.degradation_reasons.warm_cascade_engaged} degrade_cold=${kpi.degradation_reasons.cold_cascade_engaged}`
      );
    },
    180_000
  );
});
