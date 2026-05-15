import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { buildQuestionDiagnostic } from "../longmemeval/diagnostics.js";
import { runLongMemEvalMultiturn } from "../longmemeval/multiturn.js";
import {
  resolveBenchEmbeddingProviderLabel,
  runLongMemEval
} from "../longmemeval/runner.js";
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
  it("normalizes optional recall diagnostics without requiring protocol schema changes", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-diagnostics",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-decoy", rank: 1, relevance_score: 0.9 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider_state: "provider_returned",
          candidate_pool: [
            {
              object_id: "memory-gold",
              pre_budget_rank: 3,
              plane_first_admitted: "domain_tag_cluster",
              plane_winning_admission: "domain_tag_cluster",
              source_planes: ["domain_tag_cluster", "openai_api_key"],
              lexical_rank: 0.42,
              structural_score: 0.88,
              source_channels: [
                "domain_tag_cluster",
                "plane:domain_tag_cluster",
                "sk-live-secret",
                "sk_live_secret",
                "openai_api_key",
                "raw_memory_content"
              ],
              budget_drop_reason: "delivery_budget"
            }
          ]
        }
      }
    });

    expect(row.recall_diagnostics_present).toBe(true);
    expect(row.provider_state).toBe("provider_returned");
    expect(row.miss_classification).toBe("budget_dropped");
    expect(row.gold[0]).toMatchObject({
      object_id: "memory-gold",
      candidate_status: "candidate_not_delivered",
      pre_budget_rank: 3,
      plane_first_admitted: "domain_tag_cluster",
      lexical_rank: 0.42,
      structural_score: 0.88,
      source_channels: ["domain_tag_cluster", "plane:domain_tag_cluster"],
      budget_drop_reason: "delivery_budget"
    });
    expect(JSON.stringify(row)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row)).not.toContain("sk_live_secret");
    expect(JSON.stringify(row)).not.toContain("openai_api_key");
    expect(JSON.stringify(row)).not.toContain("raw_memory_content");
  });

  it("redacts arbitrary provider degradation text from diagnostics sidecars", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-secret-provider-text",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider: {
            state: "provider_failed",
            degradation_reason: "sk-live-secret file:/home/me/.config/alaya/secrets/openai"
          },
          candidates: []
        }
      }
    });

    expect(row.provider_state).toBe("provider_failed");
    expect(row.provider_degradation_reason).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row)).not.toContain("/home/me/.config/alaya/secrets/openai");
  });

  it("labels env embedding benchmarks with provider and model metadata", () => {
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://api.yunwu.example/v1",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-large"
      })
    ).toBe("yunwu:text-embedding-3-large");
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://embedding-proxy.example/v1",
        OPENAI_EMBEDDING_MODEL: "custom-embed"
      })
    ).toBe("openai-compatible:custom-embed");
    expect(resolveBenchEmbeddingProviderLabel("env", {})).toBe(
      "openai:text-embedding-3-small"
    );
    expect(resolveBenchEmbeddingProviderLabel("disabled", {})).toBe("none");
  });

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
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 2 }),
        "utf8"
      );

      // Pinned meta lookup root for the loadDataset checksum guard.
      const pinnedMetaRoot = join(tmpDir, "pinned-meta");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 2,
          first_pinned_at: "2026-05-14T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot
      });

      // Slug format must match SLUG_PATTERN
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/);

      // harness_mode must reflect the real MCP chain — never direct_db_seed.
      expect(result.payload.harness_mode).toBe("mcp_propose_review");
      expect(result.payload.embedding_provider).toBe("none");

      // KPI payload must pass schema validation
      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);

      // Structural assertions
      expect(result.payload.bench_name).toBe("public");
      // Variant=longmemeval_oracle → split=longmemeval-oracle (split now
      // tracks variant; Oracle and S are archived under distinct splits
      // because their session-set filter semantics differ).
      expect(result.payload.split).toBe("longmemeval-oracle");
      expect(result.payload.kpi.per_scenario).toHaveLength(2);
      expect(result.payload.kpi.per_scenario[0]?.id).toBe("q001");
      expect(result.payload.kpi.per_scenario[1]?.id).toBe("q002");
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as {
        schema_version: number;
        provider_state_summary: {
          provider_not_requested: number;
          provider_returned_rate: number;
        };
        questions: Array<{
          question_id: string;
          gold_memory_ids: string[];
          recall_diagnostics_present: boolean;
          recall_diagnostics_keys: string[];
        }>;
      };
      expect(diagnostics.schema_version).toBe(1);
      expect(diagnostics.provider_state_summary.provider_not_requested).toBe(2);
      expect(diagnostics.provider_state_summary.provider_returned_rate).toBe(0);
      expect(diagnostics.questions).toHaveLength(2);
      expect(diagnostics.questions[0]?.question_id).toBe("q001");
      expect(diagnostics.questions[0]?.gold_memory_ids.length).toBeGreaterThan(0);
      expect(diagnostics.questions[0]?.recall_diagnostics_present).toBe(true);
      expect(diagnostics.questions[0]?.recall_diagnostics_keys).toContain("candidates");
      expect(JSON.stringify(diagnostics)).not.toContain("correct fact");

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
        kpi.degradation_reasons.cold_cascade_engaged +
        kpi.degradation_reasons.recall_explainability_partial;
      expect(degradeTotal).toBe(2);

      // eslint-disable-next-line no-console
      console.log(
        `[longmemeval mock harness] r_at_1=${kpi.r_at_1} r_at_5=${kpi.r_at_5} r_at_10=${kpi.r_at_10} tier_hot=${kpi.tier_distribution.hot} tier_warm=${kpi.tier_distribution.warm} tier_cold=${kpi.tier_distribution.cold} degrade_none=${kpi.degradation_reasons.none} degrade_warm=${kpi.degradation_reasons.warm_cascade_engaged} degrade_cold=${kpi.degradation_reasons.cold_cascade_engaged}`
      );
    },
    180_000
  );

  it(
    "archives public-multiturn runs with round KPIs and diagnostics sidecar",
    async () => {
      const dataDir = join(tmpDir, "longmemeval-multiturn");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-multiturn");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("qmt001", "session-a")
      ];
      const variant = "longmemeval_s";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 1 }),
        "utf8"
      );
      const pinnedMetaRoot = join(tmpDir, "pinned-meta-multiturn");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 1,
          first_pinned_at: "2026-05-15T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      const result = await runLongMemEvalMultiturn({
        variant,
        limit: 1,
        rounds: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot
      });

      expect(result.payload.bench_name).toBe("public-multiturn");
      expect(result.payload.kpi.multiturn_rounds).toBe(2);
      expect(result.payload.kpi.r_at_5_round_1).toBeGreaterThanOrEqual(0);
      expect(result.payload.kpi.r_at_5_round_n).toBe(result.payload.kpi.r_at_5);
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as { bench_name: string; questions: Array<{ round_index: number | null }> };
      expect(diagnostics.bench_name).toBe("public-multiturn");
      expect(diagnostics.questions.map((row) => row.round_index)).toEqual([1, 2]);
    },
    180_000
  );
});
