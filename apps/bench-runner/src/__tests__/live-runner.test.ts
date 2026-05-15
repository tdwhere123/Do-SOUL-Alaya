import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { runLiveBench } from "../live/runner.js";

describe("live strict-real bench archive", () => {
  let tmpRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "live-bench-"));
    sourcePath = path.join(tmpRoot, "main-check.json");
    await writeFile(sourcePath, JSON.stringify(buildSource(), null, 2) + "\n", "utf8");
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes live kpi/report/gate sidecar under bench-history/live", async () => {
    const historyRoot = path.join(tmpRoot, "history");

    const result = await runLiveBench({ historyRoot, sourcePath });

    expect(result.slug).toMatch(/^2026-05-12T053953Z-[0-9a-f]{7,40}$/u);
    expect(result.status).toBe("pass");
    expect(result.kpiPath).toContain(path.join("history", "live", result.slug, "kpi.json"));
    expect(result.payload.bench_name).toBe("live");
    expect(result.payload.split).toBe("strict-real");
    expect(result.payload.harness_mode).toBe("live_strict_real");
    expect(result.payload.evaluated_count).toBe(500);
    expect(result.payload.kpi.r_at_1).toBe(0.914);
    expect(result.payload.kpi.r_at_5).toBe(0.946);
    expect(result.payload.kpi.r_at_10).toBe(0.946);

    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Live strict-real gates");
    expect(report).toContain("provider_top5");
    expect(report).toContain("R@10 note");

    const sidecarRaw = await readFile(result.liveGatesPath, "utf8");
    expect(sidecarRaw).not.toContain("raw_transcript");
    expect(sidecarRaw).not.toContain("foreign_object_id");
    expect(sidecarRaw).not.toContain("text_excerpt");
    expect(sidecarRaw).not.toContain("db_metrics");
    expect(sidecarRaw).not.toContain("verbose provider error");
    const sidecar = JSON.parse(sidecarRaw) as {
      latest_run_id: string;
      gates: readonly { id: string; pass: boolean; observed: unknown }[];
      security: { raw_key_hits: number; exact_secret_hits: number };
    };
    expect(sidecar.latest_run_id).toBe("2026-05-12T05-27-16-166Z-strict-real");
    expect(sidecar.security).toEqual({ raw_key_hits: 0, exact_secret_hits: 0 });
    expect(sidecar.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "provider_top5", pass: true })
      ])
    );
    expect(sidecar.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "structured_error_redaction",
          observed: "[redacted_non_scalar]"
        })
      ])
    );
  });

  it("exposes the live archive through the bench-runner CLI", async () => {
    const historyRoot = path.join(tmpRoot, "cli-history");
    let stdout = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runCli([
        "live",
        "--source",
        sourcePath,
        "--history-root",
        historyRoot
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Archiving live strict-real check");
      expect(stdout).toContain("Live gates:");
      expect(await readFile(path.join(historyRoot, "live", "latest-baseline.json"), "utf8"))
        .toContain("kpi.json");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("refuses to archive strict-real metrics without embedding-real-provider evidence", async () => {
    const source = buildSource() as {
      metrics: { modes: Array<{ mode: string }> };
    };
    source.metrics.modes = source.metrics.modes.filter((mode) => mode.mode !== "embedding-real-provider");
    await writeFile(sourcePath, JSON.stringify(source, null, 2) + "\n", "utf8");
    const historyRoot = path.join(tmpRoot, "missing-provider-history");

    await expect(runLiveBench({ historyRoot, sourcePath }))
      .rejects.toThrow(/embedding-real-provider/);
    await expect(
      readFile(path.join(historyRoot, "live", "latest-baseline.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function buildSource(): unknown {
  return {
    latest_run_id: "2026-05-12T05-27-16-166Z-strict-real",
    status: "pass",
    generated_at: "2026-05-12T05:39:53.229Z",
    run_dir: ".do-it/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real",
    report: ".do-it/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real/report.md",
    summary: ".do-it/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real/main-check-run.json",
    gates: [
      {
        id: "provider_top5",
        pass: true,
        threshold: ">= 88%",
        observed: 0.946,
        evidence: "embedding-real-provider/result.json"
      },
      {
        id: "garden_followup_success_rate",
        pass: true,
        threshold: ">= 95%",
        observed: 1,
        evidence: "garden-audit-loop/summary.json"
      },
      {
        id: "structured_error_redaction",
        pass: true,
        threshold: {
          error: "verbose provider error should not be archived",
          cross_workspace: { foreign_object_id: "gate-threshold-object-id" }
        },
        observed: {
          error: "verbose provider error should not be archived",
          cross_workspace: { foreign_object_id: "gate-observed-object-id" }
        },
        evidence: "structured-error/result.json"
      }
    ],
    metrics: {
      samples: {
        requested: 500,
        actual: 500,
        query_count: 500
      },
      provider_health: {
        embedding: {
          ok: true,
          status: 200,
          vector_dimensions: 1536
        },
        garden: {
          ok: true,
          status: 200,
          text_excerpt: "provider health body should not be archived"
        }
      },
      modes: [
        {
          mode: "keyword-local",
          raw_transcript: "raw transcript should not be archived",
          recall_metrics: {
            total_queries: 500,
            top1_hits: 480,
            top5_hits: 498,
            top1_rate: 0.96,
            top5_rate: 0.996,
            query_error_count: 0,
            query_error_rate: 0,
            semantic_supplement_count: 0,
            semantic_supplement_rate: 0,
            degraded_count: 500,
            p50_ms: 22.38,
            p95_ms: 35.22,
            max_ms: 72.1
          },
          mcp_initialize_failed: 0,
          cross_workspace: {
            foreign_object_id: "should-not-be-archived"
          }
        },
        {
          mode: "embedding-real-provider",
          raw_transcript: "provider transcript should not be archived",
          recall_metrics: {
            total_queries: 500,
            top1_hits: 457,
            top5_hits: 473,
            top1_rate: 0.914,
            top5_rate: 0.946,
            query_error_count: 0,
            query_error_rate: 0,
            semantic_supplement_count: 499,
            semantic_supplement_rate: 0.998,
            degraded_count: 500,
            p50_ms: 832.6,
            p95_ms: 1504.71,
            max_ms: 2563.92
          },
          mcp_initialize_failed: 0,
          cross_workspace: {
            foreign_object_id: "provider-object-should-not-be-archived"
          }
        }
      ],
      garden: {
        task_count: 120,
        schema_valid_rate: 0.9917,
        accepted_rate: 0.9917,
        durable_write_success_rate: 1,
        accepted_followup_success_rate: 1,
        unreviewed_durable_write_count: 0,
        db_metrics: {
          event_log: 6058
        }
      },
      security: {
        raw_key_hits: 0,
        exact_secret_hits: 0,
        hit_files: ["should-not-be-archived"]
      }
    }
  };
}
