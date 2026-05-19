import { execSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entrySlug } from "@do-soul/alaya-eval";
import { runControlledReplay } from "../controlled-replay/runner.js";

const CANONICAL_SLUG_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}$/;

describe("controlled replay runner", () => {
  it(
    "archives all M0 scenario labels with real propose/review and recall evidence",
    async () => {
      const historyRoot = await mkdtemp(join(tmpdir(), "alaya-controlled-replay-"));

      const result = await runControlledReplay({ historyRoot });

      expect(result.slug).toMatch(CANONICAL_SLUG_PATTERN);
      expect(result.archivePath).toBe(
        join(historyRoot, "public", result.slug, "controlled-replay.json")
      );
      const archive = JSON.parse(await readFile(result.archivePath, "utf8")) as {
        readonly schema_version: number;
        readonly scenarios: readonly { readonly label: string }[];
        readonly metrics: {
          readonly rank_distribution: Record<string, number>;
          readonly non_monotonic: { readonly count: number };
          readonly active_constraints: { readonly count: number };
          readonly budget_drop: { readonly max_entries: number };
          readonly high_lexical_demoted: { readonly count: number };
          readonly conflict_penalty: { readonly count: number };
          readonly cold_warm_delta: Record<string, unknown>;
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
      expect(Object.values(archive.metrics.rank_distribution).reduce((a, b) => a + b, 0))
        .toBeGreaterThan(0);
      expect(archive.metrics.non_monotonic.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.active_constraints.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.budget_drop.max_entries).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.high_lexical_demoted.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.conflict_penalty.count).toBeGreaterThanOrEqual(0);
      expect(archive.metrics.cold_warm_delta).toBeDefined();
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

      await expect(access(join(historyRoot, "public", "latest-baseline.json")))
        .rejects.toThrow();
      const entryFiles = await readdir(join(historyRoot, "public", result.slug));
      expect(entryFiles).toEqual(["controlled-replay.json"]);
      await expect(stat(join(historyRoot, "public", result.slug, "kpi.json")))
        .rejects.toThrow();
    },
    180_000
  );

  it(
    "refuses to overwrite an existing deterministic archive slug",
    async () => {
      const historyRoot = await mkdtemp(join(tmpdir(), "alaya-controlled-replay-collision-"));
      const runAt = new Date("2026-05-18T01:02:03.456Z");
      const slug = entrySlug(runAt, resolveCommitSha7ForTest());
      const entryDir = join(historyRoot, "public", slug);
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
