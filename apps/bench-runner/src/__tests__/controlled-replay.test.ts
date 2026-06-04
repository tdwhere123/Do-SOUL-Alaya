import { execSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entrySlug } from "@do-soul/alaya-eval";
import {
  controlledReplayTestHooks,
  runControlledReplay
} from "../controlled-replay/runner.js";

const CANONICAL_SLUG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/;

describe("controlled replay runner", () => {
  it(
    "archives all M0 scenario labels with real propose/review and recall evidence",
    async () => {
      const historyRoot = await mkdtemp(join(tmpdir(), "alaya-controlled-replay-"));

      const result = await runControlledReplay({ historyRoot });

      expect(result.slug).toMatch(CANONICAL_SLUG_PATTERN);
      expect(result.archivePath).toBe(
        join(historyRoot, "controlled-replay", result.slug, "controlled-replay.json")
      );
      const archive = JSON.parse(await readFile(result.archivePath, "utf8")) as {
        readonly schema_version: number;
        readonly scenarios: readonly {
          readonly label: string;
          readonly metrics: {
            readonly expected_rank_by_question: Record<string, number | null>;
            readonly path_stream_top10: {
              readonly count: number;
              readonly denominator: number;
              readonly rate: number;
            };
          };
          readonly pre_report_metrics?: {
            readonly expected_rank_by_question: Record<string, number | null>;
          };
        }[];
        readonly metrics: {
          readonly rank_distribution: Record<string, number>;
          readonly hit_at_5: { readonly count: number; readonly rate: number };
          readonly non_monotonic: { readonly count: number };
          readonly active_constraints: { readonly count: number };
          readonly budget_drop: { readonly max_entries: number };
          readonly high_lexical_demoted: { readonly count: number };
          readonly conflict_penalty: { readonly count: number };
          readonly evidence_stream_gold_delivery: {
            readonly count: number;
            readonly denominator: number;
            readonly rate: number;
          };
          readonly path_stream_top10: {
            readonly count: number;
            readonly denominator: number;
            readonly rate: number;
          };
          readonly cold_warm_delta: Record<string, unknown>;
        };
        readonly native_health_gates: {
          readonly verdict: "ok" | "fail";
          readonly gates: readonly {
            readonly id: string;
            readonly passed: boolean;
          }[];
        };
        readonly contribution_suspects: readonly unknown[];
        readonly evidence: {
          readonly harness_mode: string;
          readonly recall_path: string;
          readonly mcp_propose_review: {
            readonly seed_count: number;
            readonly proposal_count: number;
          };
          readonly production_recall: {
            readonly delivery_count: number;
            readonly diagnostics_count: number;
          };
          readonly report_context_usage: {
            readonly mode: string;
            readonly delivery_ids: readonly string[];
          };
        };
      };

      expect(archive.schema_version).toBe(1);
      expect(archive.scenarios.map((scenario) => scenario.label)).toEqual([
        "uniform-fact",
        "rotated-kind",
        "stress-policy-max10-conflict-true",
        "chat-policy-max10-conflict-false",
        "cold-report-context-usage-none",
        "warm-report-context-usage-mixed"
      ]);
      const coldScenario = archive.scenarios.find(
        (scenario) => scenario.label === "cold-report-context-usage-none"
      );
      const warmScenario = archive.scenarios.find(
        (scenario) => scenario.label === "warm-report-context-usage-mixed"
      );
      expect(coldScenario?.metrics.expected_rank_by_question["q-path-target"]).toBeNull();
      expect(warmScenario?.pre_report_metrics?.expected_rank_by_question["q-path-target"])
        .toBeNull();
      expect(warmScenario?.metrics.expected_rank_by_question["q-path-target"])
        .toBeLessThanOrEqual(5);
      expect(Object.values(archive.metrics.rank_distribution).reduce((a, b) => a + b, 0))
        .toBeGreaterThan(0);
      expect(archive.metrics.hit_at_5.count).toBeGreaterThan(0);
      expect(archive.metrics.hit_at_5.rate).toBeGreaterThan(0);
      expect(archive.metrics.non_monotonic.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.active_constraints.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.budget_drop.max_entries).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.high_lexical_demoted.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.conflict_penalty.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.evidence_stream_gold_delivery.denominator)
        .toBeGreaterThan(0);
      expect(archive.metrics.evidence_stream_gold_delivery.rate)
        .toBeGreaterThanOrEqual(0.15);
      expect(warmScenario?.metrics.path_stream_top10.denominator)
        .toBeGreaterThan(0);
      expect(warmScenario?.metrics.path_stream_top10.rate)
        .toBeGreaterThanOrEqual(0.1);
      expect(warmScenario?.metrics.expected_rank_by_question["q-path-target"])
        .toBeLessThanOrEqual(5);
      expect(archive.metrics.cold_warm_delta).toBeDefined();
      expect(archive.native_health_gates.gates.map((gate) => gate.id)).toEqual([
        "trust_loop_activation_gain",
        "evidence_stream_gold_delivery",
        "path_stream_top10_contribution",
        "plasticity_gradient_rank_gain"
      ]);
      expect(archive.native_health_gates.gates.every((gate) => gate.passed)).toBe(true);
      expect(archive.native_health_gates.verdict).toBe("ok");
      expect(archive.contribution_suspects).toHaveLength(3);
      expect(archive.evidence.harness_mode).toBe("mcp_propose_review");
      expect(archive.evidence.mcp_propose_review.seed_count).toBeGreaterThan(0);
      expect(archive.evidence.mcp_propose_review.proposal_count).toBe(
        archive.evidence.mcp_propose_review.seed_count
      );
      expect(archive.evidence.recall_path).toBe("production_recall_service");
      expect(archive.evidence.production_recall.delivery_count).toBeGreaterThan(0);
      expect(archive.evidence.production_recall.diagnostics_count).toBeGreaterThan(0);
      expect(archive.evidence.report_context_usage.mode).toBe("mixed");
      expect(archive.evidence.report_context_usage.delivery_ids.length).toBeGreaterThan(0);

      await expect(access(join(historyRoot, "public")))
        .rejects.toThrow();
      await expect(access(join(historyRoot, "controlled-replay", "latest-baseline.json")))
        .rejects.toThrow();
      const entryFiles = await readdir(join(historyRoot, "controlled-replay", result.slug));
      expect(entryFiles).toEqual(["controlled-replay.json"]);
      await expect(stat(join(historyRoot, "controlled-replay", result.slug, "kpi.json")))
        .rejects.toThrow();
    },
    180_000
  );

  it("counts KN.4 path contribution against all top-10 candidates", () => {
    const diagnostics = [
      buildDiagnostic("gold-path", 1, { path_expansion: 0.25 }),
      ...Array.from({ length: 9 }, (_, index) =>
        buildDiagnostic(`decoy-${index + 1}`, index + 2, {})
      )
    ];

    const metrics = controlledReplayTestHooks.computeMetrics([
      {
        questionId: "q-path-target",
        deliveryId: "delivery-1",
        results: [],
        activeConstraints: [],
        diagnostics,
        expectedObjectIds: ["gold-path"],
        expectedRank: 1
      }
    ]);

    expect(metrics.path_stream_top10).toEqual({
      count: 1,
      denominator: 10,
      rate: 0.1
    });
  });

  it(
    "refuses to overwrite an existing deterministic archive slug",
    async () => {
      const historyRoot = await mkdtemp(join(tmpdir(), "alaya-controlled-replay-collision-"));
      const runAt = new Date("2026-05-18T01:02:03.456Z");
      const slug = entrySlug(runAt, resolveCommitSha7ForTest());
      const entryDir = join(historyRoot, "controlled-replay", slug);
      const archivePath = join(entryDir, "controlled-replay.json");
      await mkdir(entryDir, { recursive: true });
      await writeFile(archivePath, "sentinel\n", "utf8");

      await expect(runControlledReplay({ historyRoot, runAt })).rejects.toThrow(
        /refusing to overwrite/
      );
      await expect(readFile(archivePath, "utf8")).resolves.toBe("sentinel\n");
    },
    180_000
  );
});

function resolveCommitSha7ForTest(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

function buildDiagnostic(
  objectId: string,
  finalRank: number,
  fusedRankContributionPerStream: Readonly<Record<string, number>>
) {
  return {
    object_id: objectId,
    pre_budget_rank: finalRank,
    fused_rank: finalRank,
    final_rank: finalRank,
    dropped_reason: null,
    lexical_rank: finalRank,
    fused_rank_contribution_per_stream: fusedRankContributionPerStream,
    admission_planes: [],
    source_channels: []
  };
}
