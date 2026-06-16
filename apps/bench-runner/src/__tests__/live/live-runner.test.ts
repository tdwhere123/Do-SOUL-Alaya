import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { resolveGitDir, runLiveBench } from "../../live/runner.js";

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
    expect(report).not.toContain("raw_transcript");
    expect(report).not.toContain("foreign_object_id");
    expect(report).not.toContain("text_excerpt");
    expect(report).not.toContain("db_metrics");
    expect(report).not.toContain("verbose provider error");
    expect(report).not.toContain("sk-redacted-test");
    expect(report).not.toContain("OPENAI_API_KEY");
    expect(report).toContain("[redacted_sensitive_scalar]");

    const sidecarRaw = await readFile(result.liveGatesPath, "utf8");
    expect(sidecarRaw).not.toContain("raw_transcript");
    expect(sidecarRaw).not.toContain("foreign_object_id");
    expect(sidecarRaw).not.toContain("text_excerpt");
    expect(sidecarRaw).not.toContain("db_metrics");
    expect(sidecarRaw).not.toContain("verbose provider error");
    expect(sidecarRaw).not.toContain("sk-redacted-test");
    expect(sidecarRaw).not.toContain("OPENAI_API_KEY");
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
      expect(await readFile(path.join(historyRoot, "live", "latest-run.json"), "utf8"))
        .toContain("kpi.json");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("resolves normal checkout .git directories without reading them as files", async () => {
    const repoRoot = path.join(tmpRoot, "normal-checkout");
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });

    expect(resolveGitDir(repoRoot)).toBe(path.join(repoRoot, ".git"));
  });

  it("resolves worktree .git files to the referenced gitdir", async () => {
    const repoRoot = path.join(tmpRoot, "worktree-checkout");
    const gitDir = path.join(tmpRoot, "main.git", "worktrees", "wt");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(path.join(repoRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    expect(resolveGitDir(repoRoot)).toBe(gitDir);
  });

  it("archives per-run main-check-run summaries from historical live-check runs", async () => {
    const historyRoot = path.join(tmpRoot, "run-summary-history");
    const wrapper = buildSource() as LiveWrapperSource;
    const directSummary = {
      run_id: wrapper.latest_run_id,
      status: wrapper.status,
      finished_at: wrapper.generated_at,
      artifacts: {
        run_dir: wrapper.run_dir
      },
      samples: wrapper.metrics.samples,
      provider_health: wrapper.metrics.provider_health,
      modes: wrapper.metrics.modes,
      garden: wrapper.metrics.garden,
      security: wrapper.metrics.security,
      gates: wrapper.gates
    };
    await writeFile(sourcePath, JSON.stringify(directSummary, null, 2) + "\n", "utf8");

    const result = await runLiveBench({ historyRoot, sourcePath });

    expect(result.status).toBe("pass");
    expect(result.payload.dataset.source).toBe(`${sourcePath}#${wrapper.latest_run_id}`);
    const sidecarRaw = await readFile(result.liveGatesPath, "utf8");
    const sidecar = JSON.parse(sidecarRaw) as {
      summary: string;
      source_path: string;
      latest_run_id: string;
    };
    expect(sidecar.latest_run_id).toBe(wrapper.latest_run_id);
    expect(sidecar.summary).toBe(sourcePath);
    expect(sidecar.source_path).toBe(sourcePath);
    expect(sidecarRaw).not.toContain("raw transcript should not be archived");
    expect(sidecarRaw).not.toContain("provider-object-should-not-be-archived");
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
      readFile(path.join(historyRoot, "live", "latest-run.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps failed live source imports out of latest-passing pointers", async () => {
    const historyRoot = path.join(tmpRoot, "failed-source-history");

    const passing = await runLiveBench({ historyRoot, sourcePath });

    const failingSource = buildSource() as LiveWrapperSource;
    failingSource.latest_run_id = "2026-05-13T05-27-16-166Z-strict-real";
    failingSource.generated_at = "2026-05-13T05:39:53.229Z";
    failingSource.status = "fail";
    failingSource.gates = [
      {
        id: "provider_top5",
        pass: false,
        threshold: ">= 88%",
        observed: 0.84,
        evidence: "embedding-real-provider/result.json"
      }
    ];
    await writeFile(sourcePath, JSON.stringify(failingSource, null, 2) + "\n", "utf8");

    const failed = await runLiveBench({ historyRoot, sourcePath });

    expect(failed.status).toBe("fail");
    expect(await readFile(path.join(historyRoot, "live", "latest-run.json"), "utf8"))
      .toContain(failed.slug);
    expect(await readFile(path.join(historyRoot, "live", "latest-passing.json"), "utf8"))
      .toContain(passing.slug);
    await expect(readFile(failed.findingsPath, "utf8"))
      .resolves.toContain("Live strict-real source gate failures");
  });

  it("diffs live imports against the latest passing baseline", async () => {
    const historyRoot = path.join(tmpRoot, "passing-baseline-history");
    await runLiveBench({ historyRoot, sourcePath });

    const failingSource = buildSource() as LiveWrapperSource;
    failingSource.latest_run_id = "2026-05-13T05-27-16-166Z-strict-real";
    failingSource.generated_at = "2026-05-13T05:39:53.229Z";
    failingSource.status = "fail";
    failingSource.metrics.modes[1]!.recall_metrics.top5_rate = 0.8;
    failingSource.gates = [
      {
        id: "provider_top5",
        pass: false,
        threshold: ">= 88%",
        observed: 0.8,
        evidence: "embedding-real-provider/result.json"
      }
    ];
    await writeFile(sourcePath, JSON.stringify(failingSource, null, 2) + "\n", "utf8");
    await runLiveBench({ historyRoot, sourcePath });

    const currentSource = buildSource() as LiveWrapperSource;
    currentSource.latest_run_id = "2026-05-14T05-27-16-166Z-strict-real";
    currentSource.generated_at = "2026-05-14T05:39:53.229Z";
    currentSource.metrics.modes[1]!.recall_metrics.top5_rate = 0.94;
    await writeFile(sourcePath, JSON.stringify(currentSource, null, 2) + "\n", "utf8");

    const current = await runLiveBench({ historyRoot, sourcePath });
    const report = await readFile(current.reportPath, "utf8");

    expect(report).toContain("| r_at_5 | 0.9460 | 0.9400 |");
    expect(report).not.toContain("| r_at_5 | 0.8000 | 0.9400 |");
  });
});

type LiveWrapperSource = {
  latest_run_id: string;
  status: "pass" | "fail";
  generated_at: string;
  run_dir: string;
  gates: unknown[];
  metrics: {
    samples: unknown;
    provider_health: unknown;
    modes: Array<{ mode: string; recall_metrics: { top5_rate: number } }>;
    garden: unknown;
    security: unknown;
  };
};

function buildSource(): unknown {
  return {
    latest_run_id: "2026-05-12T05-27-16-166Z-strict-real",
    status: "pass",
    generated_at: "2026-05-12T05:39:53.229Z",
    run_dir: "var/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real",
    report: "var/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real/report.md",
    summary: "var/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real/main-check-run.json",
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
      },
      {
        id: "scalar_secret_redaction",
        pass: true,
        threshold: "sk-redacted-test should not be archived",
        observed: "OPENAI_API_KEY and raw_transcript should not be archived",
        evidence: "provider error foreign_object_id text_excerpt db_metrics"
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
