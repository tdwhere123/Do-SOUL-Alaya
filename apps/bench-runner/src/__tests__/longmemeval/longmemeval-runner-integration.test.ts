import { createHash } from "node:crypto";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";

import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  readLongMemEvalDiagnosticsSidecar
} from "../../longmemeval/archive-evidence.js";
import { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME } from "../../longmemeval/evidence-manifest.js";

import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

import { QaChatError } from "../../longmemeval/qa-chat.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

import { runLongMemEvalMultiturn } from "../../longmemeval/multiturn.js";

import { runLongMemEvalCrossQuestion } from "../../longmemeval/crossquestion.js";

import {
  buildLongMemEvalSidecarKey,
  buildLongMemEvalReportContextUsage,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  runLongMemEval,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits
} from "../../longmemeval/runner.js";

import {
  buildLongMemEvalArchivePayload,
  buildMockQuestion,
  withEligibleMeasurementContract,
  writeArchiveEntry
} from "./longmemeval-runner-fixture.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
  // These runs take the no-credentials offline seed path; the model value is
  // never used for a live call. Each run below passes an isolated
  // extractionCacheRoot (no manifest -> first-ever-build preflight), so this
  // model is arbitrary and the tests are decoupled from the production
  // extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

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

      const priorColdSlug = "2026-05-14T100000Z-abc1234-policy-chat";
      const priorColdRoot = join(historyRoot, "public", priorColdSlug);
      await mkdir(priorColdRoot, { recursive: true });
      await writeFile(
        join(priorColdRoot, "kpi.json"),
        JSON.stringify(
          buildLongMemEvalArchivePayload({
            run_at: "2026-05-14T10:00:00.000Z",
            policy_shape: "chat",
            simulate_report: "none"
          }),
          null,
          2
        ) + "\n",
        "utf8"
      );
      await writeFile(join(priorColdRoot, "report.md"), "cold report\n", "utf8");
      const priorColdEnvSlug = "2026-05-14T110000Z-def5678-policy-chat";
      const priorColdEnvRoot = join(historyRoot, "public", priorColdEnvSlug);
      await mkdir(priorColdEnvRoot, { recursive: true });
      const priorColdEnvPayload = buildLongMemEvalArchivePayload({
        run_at: "2026-05-14T11:00:00.000Z",
        alaya_commit: "def5678",
        embedding_provider: "yunwu:text-embedding-3-small",
        policy_shape: "chat",
        simulate_report: "none"
      });
      await writeFile(
        join(priorColdEnvRoot, "kpi.json"),
        JSON.stringify(
          {
            ...priorColdEnvPayload,
            kpi: {
              ...priorColdEnvPayload.kpi,
              r_at_5: 0.9
            }
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      await writeFile(join(priorColdEnvRoot, "report.md"), "cold env report\n", "utf8");

      const priorPassingRunAt = "2026-05-14T12:00:00.000Z";
      const priorFailingRunAt = "2026-05-14T13:00:00.000Z";
      await writeArchiveEntry(
        historyRoot,
        "public",
        "2026-05-14T120000Z-aaa1111-policy-chat-report-mixed",
        withEligibleMeasurementContract(buildLongMemEvalArchivePayload({
          run_at: priorPassingRunAt,
          alaya_commit: "aaa1111",
          split: "longmemeval-oracle",
          policy_shape: "chat",
          simulate_report: "mixed",
          embedding_provider: "none",
        }))
      );
      await writeArchiveEntry(
        historyRoot,
        "public",
        "2026-05-14T130000Z-bbb2222-policy-chat-report-mixed",
        buildLongMemEvalArchivePayload({
          run_at: priorFailingRunAt,
          alaya_commit: "bbb2222",
          split: "longmemeval-oracle",
          policy_shape: "chat",
          simulate_report: "mixed",
          embedding_provider: "none"
        }),
        "# findings\n- regression\n"
      );

      const weightOverridesJson = JSON.stringify({
        activation_weights_phase4b: {
          scope_match: 0.08,
          relevance: 0.2
        },
        additive: {
          CONFIDENCE_DIRECT_WEIGHT: 0.1
        },
        fusion_weights: {
          lexical_fts: 0.5
        }
      });

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        policyShape: "chat",
        simulateReport: "mixed",
        weightOverridesJson,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });

      // Slug format must match SLUG_PATTERN
      expect(result.slug).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}-policy-chat-report-mixed$/
      );

      // harness_mode must reflect the real MCP chain, never direct_db_seed.
      expect(result.payload.harness_mode).toBe("mcp_propose_review");
      expect(result.payload.recall_pipeline_version).toBe(RECALL_PIPELINE_VERSION);
      expect(result.payload.embedding_provider).toBe("none");
      expect(result.payload.policy_shape).toBe("chat");
      expect(result.payload.simulate_report).toBe("mixed");
      expect(result.payload.seed_policy).toMatchObject({
        mode: "label_independent_open_vocabulary_extraction",
        label_independent: true
      });
      expect(result.payload.seed_policy).not.toHaveProperty("object_kind");
      expect(result.payload.seed_policy?.description).not.toMatch(/\bK\d\b/);
      expect(result.payload.recall_weight_overrides).toMatchObject({
        source: "cli",
        activation_weights_phase4b: {
          scope_match: 0.08,
          relevance: 0.2
        },
        additive: {
          CONFIDENCE_DIRECT_WEIGHT: 0.1
        },
        fusion_weights: {
          lexical_fts: 0.5
        }
      });
      expect(result.payload.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);

      // KPI payload must pass schema validation
      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);
      const report = await readFile(result.reportPath, "utf8");
      expect(report).toContain("Recall weights: source=cli");
      expect(report).toContain(`Recall pipeline: ${RECALL_PIPELINE_VERSION}`);
      expect(report).toContain(
        "Seed policy: label_independent_open_vocabulary_extraction (label-independent)"
      );
      expect(report).toContain("Release evidence blockers");
      expect(report).toContain("seed_extraction_path no_credentials_fallback");
      const findings = await readFile(result.findingsPath, "utf8");
      expect(findings).toContain("seed_extraction_path no_credentials_fallback");
      expect(findings).toContain("offline_fallbacks=");

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
        commit_resolution?: {
          source: string;
          unavailable: boolean;
        };
        recall_pipeline_version: string;
        policy_shape: string;
        simulate_report: string;
        seed_extraction_path?: {
          path: string;
          offline_fallbacks: number;
        };
        report_usage: {
          mode: string;
          reports_attempted: number;
          reports_used: number;
          reports_skipped: number;
          used_object_count: number;
        };
        provider_state_summary: {
          provider_not_requested: number;
          provider_returned_rate: number;
          provider_not_requested_rate: number;
        };
        report_side_effects: {
          recalls_edge_count: number;
          memory_graph_edges_by_type: Record<string, number>;
          path_relations_total: number;
          snapshot_count: number;
        };
        scored_recall_evidence: {
          delivered_result_count: number;
          graph_support_gold_count: number;
          path_plasticity_gold_count: number;
          graph_expansion_plane_count: number;
          path_expansion_plane_count: number;
        };
        compact_schema_version: number;
        question_count: number;
        full_diagnostics_artifact_path: string;
        questions?: Array<{
          question_id: string;
          gold_memory_ids: string[];
          recall_diagnostics_present: boolean;
          recall_diagnostics_keys: string[];
          candidates: unknown[];
          query_probes?: unknown;
          quality_axes?: unknown;
        }>;
      };
      expect(diagnostics.schema_version).toBe(1);
      expect(diagnostics.commit_resolution).toMatchObject({
        source: "git",
        unavailable: false,
        sha7: expect.stringMatching(/^[0-9a-f]{7}$/iu)
      });
      expect(diagnostics.recall_pipeline_version).toBe(RECALL_PIPELINE_VERSION);
      expect(diagnostics.policy_shape).toBe("chat");
      expect(diagnostics.simulate_report).toBe("mixed");
      expect(diagnostics.seed_extraction_path).toMatchObject({
        path: "no_credentials_fallback",
        offline_fallbacks: 4
      });
      expect(diagnostics.report_usage.mode).toBe("mixed");
      expect(diagnostics.report_usage.reports_attempted).toBe(2);
      expect(
        diagnostics.report_usage.reports_used + diagnostics.report_usage.reports_skipped
      ).toBe(2);
      expect(diagnostics.report_usage.used_object_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.provider_state_summary.provider_not_requested).toBe(2);
      expect(diagnostics.provider_state_summary.provider_returned_rate).toBe(0);
      expect(diagnostics.provider_state_summary.provider_not_requested_rate).toBe(1);
      expect(diagnostics.report_side_effects.recalls_edge_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.report_side_effects.memory_graph_edges_by_type).toHaveProperty("recalls");
      expect(diagnostics.report_side_effects.path_relations_total).toBeGreaterThanOrEqual(0);
      expect(diagnostics.report_side_effects.snapshot_count).toBe(2);
      expect(diagnostics.scored_recall_evidence.delivered_result_count).toBeGreaterThan(0);
      expect(diagnostics.scored_recall_evidence.graph_support_gold_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.scored_recall_evidence.path_plasticity_gold_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.scored_recall_evidence.path_expansion_plane_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.compact_schema_version).toBe(1);
      expect(diagnostics.question_count).toBe(2);
      expect(diagnostics.questions).toHaveLength(2);
      expect(diagnostics.questions?.every((question) =>
        question.candidates.length === 0 &&
        question.query_probes !== undefined &&
        question.quality_axes !== undefined
      )).toBe(true);
      expect(diagnostics.full_diagnostics_artifact_path).not.toContain(
        join("docs", "bench-history")
      );
      expect(diagnostics.full_diagnostics_artifact_path).toMatch(/\.json\.gz$/u);
      const fullDiagnostics = await readLongMemEvalDiagnosticsSidecar(
        { historyRoot },
        "public",
        result.slug!
      ) as unknown as {
        commit_resolution?: {
          source: string;
          unavailable: boolean;
        };
        seed_extraction_path?: {
          path: string;
          offline_fallbacks: number;
        };
        report_side_effects?: {
          snapshots: Array<{
            memory_graph_edges_by_type: Record<string, number>;
          }>;
        };
        questions: Array<{
          question_id: string;
          gold_memory_ids: string[];
          recall_diagnostics_present: boolean;
          recall_diagnostics_keys: string[];
        }>;
      };
      const evidenceManifest = JSON.parse(await readFile(
        join(dirname(result.kpiPath), LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME),
        "utf8"
      )) as { artifacts: Array<{ role: string; path: string; sha256: string; bytes: number }> };
      const fullArtifactBinding = evidenceManifest.artifacts.find(
        (artifact) => artifact.role === "full_diagnostics"
      );
      const compressedBytes = await readFile(join(
        dirname(result.kpiPath),
        diagnostics.full_diagnostics_artifact_path
      ));
      expect(fullArtifactBinding).toMatchObject({
        path: diagnostics.full_diagnostics_artifact_path,
        bytes: compressedBytes.byteLength,
        sha256: createHash("sha256").update(compressedBytes).digest("hex")
      });
      expect(fullDiagnostics.commit_resolution).toMatchObject({
        source: "git",
        unavailable: false,
        sha7: expect.stringMatching(/^[0-9a-f]{7}$/iu)
      });
      expect(fullDiagnostics.seed_extraction_path).toMatchObject({
        path: "no_credentials_fallback",
        offline_fallbacks: 4
      });
      expect(fullDiagnostics.report_side_effects?.snapshots).toHaveLength(2);
      expect(fullDiagnostics.questions).toHaveLength(2);
      expect(fullDiagnostics.questions[0]?.question_id).toBe("q001");
      expect(fullDiagnostics.questions[0]?.gold_memory_ids.length).toBeGreaterThan(0);
      expect(fullDiagnostics.questions[0]?.recall_diagnostics_present).toBe(true);
      expect(fullDiagnostics.questions[0]?.recall_diagnostics_keys).toContain("candidates");
      expect(JSON.stringify(diagnostics)).not.toContain("correct fact");
      const comparison = JSON.parse(
        await readFile(
          join(dirname(result.kpiPath), LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME),
          "utf8"
        )
      ) as {
        current: { simulate_report: string; r_at_5: number };
        opposite: { simulate_report: string; r_at_5: number } | null;
        delta_current_minus_opposite: {
          r_at_5: number;
          report_side_effects: { recalls_edge_count: number | null };
          scored_recall_evidence: { path_expansion_plane_count: number | null };
        } | null;
      };
      expect(comparison.current.simulate_report).toBe("mixed");
      expect(comparison.opposite?.simulate_report).toBe("none");
      expect(comparison.opposite?.r_at_5).toBe(0.5);
      expect(comparison.delta_current_minus_opposite?.r_at_5).toBeCloseTo(
        result.payload.kpi.r_at_5 - 0.5
      );
      expect(
        comparison.delta_current_minus_opposite?.report_side_effects.recalls_edge_count
      ).toBeNull();
      expect(
        comparison.delta_current_minus_opposite?.scored_recall_evidence.path_expansion_plane_count
      ).toBeNull();

      // All rate values are in [0, 1]
      const kpi = result.payload.kpi;
      expect(kpi.r_at_1).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_1).toBeLessThanOrEqual(1);
      expect(kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(kpi.r_at_10).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_10).toBeLessThanOrEqual(1);

      // Degradation reasons sum to the number of evaluated questions;
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
});
